require('regenerator-runtime/runtime');
const PlaywrightEnvironment = require('jest-playwright-preset/lib/PlaywrightEnvironment').default;

const sanitizeURL = (url) => {
  let finalURL = url
  // prepend URL protocol if not there
  if (finalURL.indexOf("http://") === -1 && finalURL.indexOf("https://") === -1) {
    finalURL = 'http://' + finalURL;
  }

  // remove iframe.html if present
  finalURL = finalURL.replace(/iframe.html\s*$/, "");

  // add forward slash at the end if not there
  if (finalURL.slice(-1) !== '/') {
    finalURL = finalURL + '/';
  }

  return finalURL;
}

class CustomEnvironment extends PlaywrightEnvironment {
  async setup() {
    await super.setup();
    const page = this.global.page;
    const start = new Date();
    const targetURL = sanitizeURL(process.env.TARGET_URL || `http://localhost:6006`);

    const referenceURL = process.env.REFERENCE_URL && sanitizeURL(process.env.REFERENCE_URL);

    if ('TARGET_URL' in process.env && !process.env.TARGET_URL) {
      console.log(`Received TARGET_URL but with a falsy value: ${process.env.TARGET_URL
        }, will fallback to ${targetURL} instead.`)
    }

    await page.goto(`${targetURL}iframe.html`, { waitUntil: 'load' }).catch((err) => {
      if (err.message?.includes('ERR_CONNECTION_REFUSED')) {
        const errorMessage = `Could not access the Storybook instance at ${targetURL}. Are you sure it's running?\n\n${err.message}`;
        throw new Error(errorMessage)
      }

      throw err;
    }); // FIXME: configure
    console.log(`page loaded in ${new Date() - start}ms.`);

    // if we ever want to log something from the browser to node
    await page.exposeBinding('logToPage', (_, message) => console.log(message));

    await page.addScriptTag({
      content: `
        class StorybookTestRunnerError extends Error {
          constructor(storyId, hasPlayFn, errorMessage) {
            super(errorMessage);
            this.name = 'StorybookTestRunnerError';
            const storyUrl = \`${referenceURL || targetURL}?path=/story/\${storyId}\`;
            const finalStoryUrl = storyUrl + (hasPlayFn ? '&addonPanel=storybook/interactions/panel' : '');

            this.message = \`\nAn error occurred in the following story:\n\${finalStoryUrl}\n\nMessage:\n \${errorMessage}\`;
          }
        }

        async function __throwError(storyId, errorMessage) {
          throw new StorybookTestRunnerError(storyId, errorMessage);
        }

        async function __waitForElement(selector) {
          return new Promise((resolve, reject) => {

            const timeout = setTimeout(() => {
              reject();
            }, 10000);

            if (document.querySelector(selector)) {
              clearTimeout(timeout);
              return resolve(document.querySelector(selector));
            }

            const observer = new MutationObserver(mutations => {
              if (document.querySelector(selector)) {
                clearTimeout(timeout);
                resolve(document.querySelector(selector));
                observer.disconnect();
              }
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true
            });
          });
        }

        async function __test(storyId, hasPlayFn) {
          try {
            await __waitForElement('#root');
          } catch(err) {
            const message = \`Timed out waiting for Storybook to load after 10 seconds. Are you sure the Storybook is running correctly in that URL? Is the Storybook private (e.g. under authentication layers)?\n\n\nHTML: \${document.body.innerHTML}\`;
            throw new StorybookTestRunnerError(storyId, hasPlayFn, message);
          }

          const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
          if(!channel) {
            throw new StorybookTestRunnerError(
              storyId,
              hasPlayFn,
              'The test runner could not access the Storybook channel. Are you sure the Storybook is running correctly in that URL?'
            );
          }

          return new Promise((resolve, reject) => {
            channel.on('storyRendered', () => resolve(document.getElementById('root')));
            channel.on('storyUnchanged', () => resolve(document.getElementById('root')));
            channel.on('storyErrored', ({ description }) => reject(
              new StorybookTestRunnerError(storyId, hasPlayFn, description))
            );
            channel.on('storyThrewException', (error) => reject(
              new StorybookTestRunnerError(storyId, hasPlayFn, error.message))
            );
            channel.on('storyMissing', (id) => id === storyId && reject(
              new StorybookTestRunnerError(storyId, hasPlayFn, 'The story was missing when trying to access it.'))
            );

            channel.emit('setCurrentStory', { storyId });
          });
        };
      `,
    });
  }

  async teardown() {
    await super.teardown();
  }

  async handleTestEvent(event) {
    await super.handleTestEvent(event);
  }
}

module.exports = CustomEnvironment;

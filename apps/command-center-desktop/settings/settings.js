const form = document.querySelector('#connection-form');
const gatewayUrl = document.querySelector('#gateway-url');
const auth = document.querySelector('#auth-mode');
const secret = document.querySelector('#secret');
const error = document.querySelector('#error');
const rememberMe = document.querySelector('#remember-me');
const button = form.querySelector('button');

function updateAuth() {
  secret.hidden = auth.value === 'none';
  secret.required = auth.value !== 'none';
  document.querySelector('#secret-label').hidden = secret.hidden;
  document.querySelector('#secret-label').textContent =
    auth.value === 'password' ? 'Password' : 'Token';
}
auth.addEventListener('change', () => {
  secret.value = '';
  updateAuth();
});
updateAuth();
button.disabled = true;
try {
  const connection = await window.farmslotDesktop.loadConnection();
  if (connection) {
    gatewayUrl.value = connection.url;
    rememberMe.checked = connection.rememberMe !== false;
    auth.value = connection.token ? 'token' : connection.password ? 'password' : 'none';
    secret.value = connection.token ?? connection.password ?? '';
    document.querySelector('#cancel').hidden = false;
    updateAuth();
  }
} catch (cause) {
  error.textContent = `Could not read the saved connection. Enter it again to replace it. ${cause.message}`;
}
button.disabled = false;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  try {
    const connection = { url: gatewayUrl.value.trim(), rememberMe: rememberMe.checked };
    if (auth.value !== 'none') connection[auth.value] = secret.value;
    await window.farmslotDesktop.saveConnection(connection);
    await window.farmslotDesktop.openUi();
  } catch (cause) {
    error.textContent = cause.message;
    button.disabled = false;
  }
});

const desktopForm = document.querySelector('#desktop-form');
const shortcut = document.querySelector('#shortcut');
const shortcutStatus = document.querySelector('#shortcut-status');
const shortcutButton = desktopForm.querySelector('button');
shortcutButton.disabled = true;
try {
  const preferences = await window.farmslotDesktop.loadPreferences();
  shortcut.value = preferences.shortcut;
  document.title = `${preferences.profile} settings`;
  shortcutStatus.textContent = preferences.shortcutError;
} catch (cause) {
  shortcutStatus.textContent = cause.message;
}
shortcutButton.disabled = false;
desktopForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  shortcutButton.disabled = true;
  try {
    await window.farmslotDesktop.saveShortcut(shortcut.value);
    shortcutStatus.textContent = shortcut.value.trim() ? 'Shortcut saved.' : 'Shortcut disabled.';
  } catch (cause) {
    shortcutStatus.textContent = cause.message;
  } finally {
    shortcutButton.disabled = false;
  }
});

document.querySelector('#cancel').addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    await window.farmslotDesktop.openUi();
  } catch (cause) {
    error.textContent = cause.message;
  }
});

const developmentForm = document.querySelector('#development-form');
const developmentEnabled = document.querySelector('#development-enabled');
const developmentUrl = document.querySelector('#development-url');
const developmentStatus = document.querySelector('#development-status');
try {
  const preferences = await window.farmslotDesktop.loadPreferences();
  developmentForm.hidden = !preferences.supportsDevelopment;
  developmentEnabled.checked = preferences.development.enabled;
  developmentUrl.value = preferences.development.url;
  document.querySelector('#development-recovery').hidden = !new URLSearchParams(
    location.search,
  ).has('developmentUnavailable');
} catch (cause) {
  error.textContent = cause.message;
}
async function openDevelopment(enabled) {
  const buttons = developmentForm.querySelectorAll('button');
  buttons.forEach((button) => {
    button.disabled = true;
  });
  developmentStatus.textContent = '';
  try {
    await window.farmslotDesktop.saveDevelopment({ enabled, url: developmentUrl.value.trim() });
    developmentEnabled.checked = enabled;
    await window.farmslotDesktop.openUi();
  } catch (cause) {
    developmentStatus.textContent = cause.message;
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
developmentForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openDevelopment(developmentEnabled.checked);
});
document.querySelector('#development-retry').addEventListener('click', () => {
  void openDevelopment(true);
});
document.querySelector('#development-bundled').addEventListener('click', () => {
  void openDevelopment(false);
});

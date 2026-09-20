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
    const preferences = await window.farmslotDesktop.loadPreferences();
    window.location.assign('/cc/' + preferences.route);
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
  document.querySelector('#cancel').href = '/cc/' + preferences.route;
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

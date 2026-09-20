const form = document.querySelector('#connection-form');
const gatewayUrl = document.querySelector('#gateway-url');
const auth = document.querySelector('#auth-mode');
const secret = document.querySelector('#secret');
const error = document.querySelector('#error');
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
    const connection = { url: gatewayUrl.value.trim() };
    if (auth.value !== 'none') connection[auth.value] = secret.value;
    await window.farmslotDesktop.saveConnection(connection);
    window.location.assign('/cc/');
  } catch (cause) {
    error.textContent = cause.message;
    button.disabled = false;
  }
});

// NODE_OPTIONS loads this before checkout code, including older env loaders.
const sandboxHome = process.env.FARMSLOT_SANDBOX_HOME;
if (sandboxHome) {
  const env = process.env;
  env.FARMSLOT_HOME = sandboxHome;
  process.env = new Proxy(env, {
    set(target, key, value) {
      return Reflect.set(target, key, key === 'FARMSLOT_HOME' ? sandboxHome : value);
    },
    deleteProperty(target, key) {
      return key === 'FARMSLOT_HOME' || Reflect.deleteProperty(target, key);
    },
  });
}

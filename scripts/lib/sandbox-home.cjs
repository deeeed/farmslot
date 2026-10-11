// The shell calls this file to merge options; Node preloads it before checkout code.
const guardOption = `--require ${JSON.stringify(__filename)}`;
function sandboxNodeOptions(options) {
  const value = String(options ?? '');
  return ` ${value} `.includes(` ${guardOption} `)
    ? value
    : `${guardOption}${value ? ` ${value}` : ''}`;
}
module.exports = { sandboxNodeOptions };

if (require.main === module) {
  process.stdout.write(sandboxNodeOptions(process.argv[2]));
} else if (process.env.FARMSLOT_SANDBOX_HOME) {
  const env = process.env;
  const pinned = {
    FARMSLOT_HOME: env.FARMSLOT_SANDBOX_HOME,
    FARMSLOT_SANDBOX_HOME: env.FARMSLOT_SANDBOX_HOME,
    FARMSLOT_SANDBOX_HOME_GUARD: __filename,
  };
  Object.assign(env, pinned);
  env.NODE_OPTIONS = sandboxNodeOptions(env.NODE_OPTIONS);
  process.env = new Proxy(env, {
    set(target, key, value) {
      return Reflect.set(
        target,
        key,
        key === 'NODE_OPTIONS'
          ? sandboxNodeOptions(value)
          : Object.hasOwn(pinned, key)
            ? pinned[key]
            : value,
      );
    },
    deleteProperty(target, key) {
      return key === 'NODE_OPTIONS'
        ? Reflect.set(target, key, sandboxNodeOptions(''))
        : Object.hasOwn(pinned, key) || Reflect.deleteProperty(target, key);
    },
  });
}

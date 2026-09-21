export function desktopProfile(value = 'production') {
  if (!['development', 'production'].includes(value)) throw new Error('Invalid desktop profile.');
  const development = value === 'development';
  return {
    development,
    name: development ? 'Farmslot Dev' : 'Farmslot',
    scheme: development ? 'farmslot-dev' : 'farmslot',
    icon: development ? 'icon-dev.png' : 'icon.png',
  };
}

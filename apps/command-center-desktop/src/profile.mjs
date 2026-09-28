export function desktopProfile(value = 'production') {
  if (!['development', 'production', 'validation'].includes(value))
    throw new Error('Invalid desktop profile.');
  const validation = value === 'validation';
  const development = validation || value === 'development';
  return {
    development,
    name: validation ? 'Farmslot Validation' : development ? 'Farmslot Dev' : 'Farmslot',
    scheme: validation ? 'farmslot-validation' : development ? 'farmslot-dev' : 'farmslot',
    icon: development ? 'icon-dev.png' : 'icon.png',
  };
}

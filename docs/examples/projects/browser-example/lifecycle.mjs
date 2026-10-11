// Refuse lifecycle operations on a browser owned outside this provider.
console.error('This provider attaches to an existing page; manage its browser outside the recipe.');
process.exitCode = 2;

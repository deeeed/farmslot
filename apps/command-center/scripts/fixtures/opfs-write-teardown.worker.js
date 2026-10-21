self.onmessage = async ({ data: { id } }) => {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('farmslot-opfs-teardown-diagnostic', {
    create: true,
  });
  for await (const name of directory.keys()) await directory.removeEntry(name);
  const file = await directory.getFileHandle(id, { create: true });
  const handle = await file.createSyncAccessHandle();
  const bytes = new Uint8Array(1024 * 1024);
  bytes.fill(42);
  try {
    self.postMessage({ phase: 'writing', id });
    for (let index = 0; index < 64; index++) {
      handle.write(bytes, { at: index * bytes.length });
      handle.flush();
    }
    self.postMessage({ phase: 'complete', id, bytes: handle.getSize() });
  } finally {
    handle.close();
    await directory.removeEntry(id);
  }
};

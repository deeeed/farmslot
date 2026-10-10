module.exports = {
  name: '@farmslot/plugin-hardlink-store',
  factory: (require) => {
    const fs = require('fs');
    const path = require('path');
    const { npath } = require('@yarnpkg/fslib');
    return {
      hooks: {
        async validateProject(project) {
          if (project.configuration.get('nmMode') !== 'hardlinks-global') return;
          const store = path.join(
            npath.fromPortablePath(project.configuration.get('globalFolder')),
            'store',
          );
          const target = path.join(store, 'v1');
          const ready = () => fs.existsSync(path.join(target, 'ff'));
          if (ready()) return;
          fs.mkdirSync(store, { recursive: true });
          const staging = fs.mkdtempSync(path.join(store, '.v1-init-'));
          try {
            // Yarn 4.5.3 exposes v1 before its buckets. Publish a complete directory.
            for (let bucket = 0; bucket < 256; bucket++)
              fs.mkdirSync(path.join(staging, bucket.toString(16).padStart(2, '0')));
            try {
              fs.renameSync(staging, target);
            } catch (error) {
              if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
              // Another installer owns the target. Do not change its buckets.
              for (let attempt = 0; !ready() && attempt < 100; attempt++)
                await new Promise((resolve) => setTimeout(resolve, 10));
              if (!ready())
                throw new Error(
                  `Yarn hardlink store is incomplete at ${target}; stop other installers and move this directory aside before retrying.`,
                );
            }
          } finally {
            fs.rmSync(staging, { recursive: true, force: true });
          }
        },
      },
    };
  },
};

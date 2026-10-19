import { PNG } from 'pngjs';

/** A real opaque 2x2 frame, so a fake recorder's snapshot can be encoded like a captured one. */
export function framePng(): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < image.data.length; offset += 4)
    image.data.set([200, 120, 40, 255], offset);
  return PNG.sync.write(image);
}

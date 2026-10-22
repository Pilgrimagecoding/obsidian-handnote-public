/** MIME type for an image file extension. */
export function imageMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'svg') return 'image/svg+xml';
  if (e === 'heic') return 'image/heic';
  return `image/${e}`;
}

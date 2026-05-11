const cache = new Map();

export function loadImage(src) {
  if (cache.has(src)) return cache.get(src);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
  cache.set(src, promise);
  return promise;
}

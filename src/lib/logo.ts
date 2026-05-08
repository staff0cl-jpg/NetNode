const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode PNG"));
    img.src = src;
  });

export const validatePngFile = async (file: File) => {
  if (file.size > MAX_LOGO_SIZE_BYTES) {
    throw new Error(`Logo is too large (max ${Math.floor(MAX_LOGO_SIZE_BYTES / 1024 / 1024)}MB)`);
  }
  if (file.type && file.type !== "image/png") {
    throw new Error("Only PNG files are allowed");
  }
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const validSignature = PNG_SIGNATURE.every((v, idx) => bytes[idx] === v);
  if (!validSignature) {
    throw new Error("Invalid PNG signature");
  }
};

export const processLogoWhiteToTransparent = async (file: File, threshold: number) => {
  const sourceDataUrl = await readAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const level = Math.max(0, Math.min(255, threshold));

  for (let i = 0; i < frame.data.length; i += 4) {
    const r = frame.data[i];
    const g = frame.data[i + 1];
    const b = frame.data[i + 2];
    if (r >= level && g >= level && b >= level) {
      frame.data[i + 3] = 0;
    }
  }
  context.putImageData(frame, 0, 0);
  return {
    originalDataUrl: sourceDataUrl,
    processedDataUrl: canvas.toDataURL("image/png"),
  };
};

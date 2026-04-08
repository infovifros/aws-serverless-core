import {brotliCompress, gzip} from 'zlib';

/**
 * Compresses the given data with gzip and returns a Base64 encoded string.
 * @param data - The data to compress (string or Buffer).
 * @returns Promise that resolves with a Base64 encoded string.
 */
export function compressAndEncodeGzip(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    gzip(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        // Convert the binary buffer to a Base64 encoded string
        resolve(result.toString('base64'));
      }
    });
  });
}

/**
 * Compresses a string or Buffer using Brotli compression and returns a Promise.
 * @param data - The data to be compressed (string or Buffer).
 * @returns A Promise that resolves with a Buffer containing the compressed data.
 */
export function compressAndEncodeBrotli(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    brotliCompress(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result.toString('base64'));
      }
    });
  });
}

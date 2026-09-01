import { NodeShape } from './NodeShapeUtil';
import { createShapeId, Editor } from 'tldraw';
export const getImageSize = (url: string) => {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };

    img.onerror = () => {
      reject(new Error('图片尺寸获取失败'));
    };

    img.src = url;
  });
};

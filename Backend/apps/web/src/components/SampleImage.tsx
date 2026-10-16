/**
 * Renders a protected sample image.
 *
 * The image endpoint needs the Authorization header, so a plain `<img src>`
 * cannot load it. This fetches the blob and hands the element an object URL,
 * revoking it on unmount so a long session does not accumulate them.
 */
import { useEffect, useState } from 'react';
import { fetchImageObjectUrl } from '../lib/api';
import { Icon } from './ui';
import './SampleImage.css';

export function SampleImage({
  imageId,
  alt,
  className = '',
}: {
  imageId: string;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;

    setUrl(null);
    setFailed(false);

    fetchImageObjectUrl(imageId)
      .then((next) => {
        if (revoked) {
          URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next;
        setUrl(next);
      })
      .catch(() => {
        if (!revoked) setFailed(true);
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  if (failed) {
    return (
      <div className={`sample-image is-empty ${className}`}>
        <Icon name="broken_image" className="icon-lg" />
        <span>This image could not be loaded.</span>
      </div>
    );
  }

  if (!url) {
    return <div className={`sample-image is-loading ${className}`} aria-busy="true" />;
  }

  return <img src={url} alt={alt} className={`sample-image ${className}`} />;
}

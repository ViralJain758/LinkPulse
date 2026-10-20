import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

function download(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

// Always black on white: inverted (dark mode) codes fail on many scanners and when printed.
export default function QrModal({ link, onClose }) {
  const ref = useRef(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
    QRCode.toString(link.shortUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
      .then(setSvg)
      .catch(() => setError('Could not generate the QR code.'));
  }, [link.shortUrl]);

  const savePng = async () => {
    try {
      download(await QRCode.toDataURL(link.shortUrl, { width: 1024, margin: 2, errorCorrectionLevel: 'M' }), `${link.slug}-qr.png`);
    } catch {
      setError('Could not generate the PNG.');
    }
  };
  const saveSvg = () => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    download(url, `${link.slug}-qr.svg`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <dialog ref={ref} className="qr-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <h2>QR code for /{link.slug}</h2>
      {error ? <p className="error" role="alert">{error}</p> : <div className="qr" role="img" aria-label={`QR code for ${link.shortUrl}`} dangerouslySetInnerHTML={{ __html: svg }} />}
      <p className="muted qr-url">{link.shortUrl}</p>
      {(link.hasPassword || link.oneTime) && (
        <p className="muted qr-note">
          {link.oneTime ? 'One-time link: the first scan uses it up. ' : ''}
          {link.hasPassword ? 'Scanners will be asked for the password.' : ''}
        </p>
      )}
      <div className="qr-actions">
        <button className="btn primary" onClick={savePng} disabled={!svg}>Download PNG</button>
        <button className="btn" onClick={saveSvg} disabled={!svg}>Download SVG</button>
        <button className="btn" onClick={() => ref.current.close()}>Close</button>
      </div>
    </dialog>
  );
}

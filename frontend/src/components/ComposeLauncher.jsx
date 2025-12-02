import React, { useState } from 'react';
import Compose from '../screens/Compose';

export default function ComposeLauncher({ onSent }) {
  const [open, setOpen] = useState(false);

  function handleOpen() { setOpen(true); }
  function handleClose() { setOpen(false); }
  function handleSent() {
    setOpen(false);
    onSent && onSent();
  }

  return (
    <>
      <button
        className="floating-compose"
        aria-label="Compose"
        onClick={handleOpen}
        title="Compose"
      >
        ✉
      </button>

      {open && (
        <Compose
          onCancel={handleClose}
          onSent={handleSent}
        />
      )}
    </>
  );
}

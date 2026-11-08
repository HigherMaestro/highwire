"use client";

import { useId, useState } from "react";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Opens a creator wallet's fee page. The address goes in the path, never anywhere else. */
export function WalletLookup() {
  const id = useId();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className="fee-lookup"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (!ADDRESS.test(v)) return setBad(true);
        window.location.assign(`/fees/creator/${v}`);
      }}
    >
      <label htmlFor={id} className="sr-only">
        A creator's wallet address
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="A creator's wallet address"
        value={value}
        aria-invalid={bad || undefined}
        onChange={(e) => (setValue(e.target.value), setBad(false))}
      />
      <button type="submit" className="button button-small">
        See what it earned
      </button>
      {bad ? <p className="small fee-lookup-error">That isn't a Solana address.</p> : null}
    </form>
  );
}

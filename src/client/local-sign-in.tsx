import { useEffect, useState } from "react";

export function LocalSignIn() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/auth/local", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json();
        if (live && result.enabled === true) setEnabled(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!enabled) return null;
  return (
    <form action="/auth/local" method="post">
      <button type="submit" className="button">
        Use local test account
      </button>
      <p className="privacy-copy">
        Local development only. No Google account required.
      </p>
    </form>
  );
}

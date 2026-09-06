export function DisconnectedState() {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-sm text-center text-[15px] leading-relaxed text-ink-muted">
        Waiting for the mesh. Tap the power icon when you are ready to connect.
      </p>
    </div>
  );
}

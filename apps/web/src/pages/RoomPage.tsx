export function RoomPage({ slug }: { slug: string }) {
  return (
    <main className="bg-bg text-text min-h-screen font-sans">
      <div className="max-w-xl mx-auto px-6 py-24">
        <p className="text-text-secondary text-body">
          Room <span className="font-mono text-text">{slug}</span> — joining lands here in R4.iv Phase 2.
        </p>
      </div>
    </main>
  );
}

import { useState, type ReactNode } from 'react';
import { Check, Eye, TriangleAlert, Users } from 'lucide-react';
import { Button } from './components/Button';
import { Input } from './components/Input';
import { Badge } from './components/Badge';
import { getTheme, setTheme, type ThemeChoice } from './theme';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-heading text-text">{title}</h2>
      <div className="mt-4 flex flex-wrap items-start gap-4 bg-surface border border-hairline rounded-md p-6">
        {children}
      </div>
    </section>
  );
}

export function Preview() {
  const [theme, setLocalTheme] = useState<ThemeChoice>(getTheme());
  const [name, setName] = useState('');
  const [bad, setBad] = useState('');

  const flip = () => {
    const next: ThemeChoice = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setLocalTheme(next);
  };

  return (
    <main className="bg-bg text-text min-h-screen font-sans">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-serif text-display text-text">Pointe — Primitives</h1>
            <p className="text-text-secondary text-body mt-1">Button · Input · Badge on the token foundation.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={flip}>
            Switch to {theme === 'dark' ? 'light' : 'dark'}
          </Button>
        </header>

        <Section title="Buttons — variants">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <Button variant="primary" leftIcon={<Check size={16} />}>With icon</Button>
        </Section>

        <Section title="Buttons — sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Section>

        <Section title="Inputs">
          <div className="w-full grid gap-4 sm:grid-cols-2">
            <Input id="name" label="Display name" placeholder="e.g. Alice" value={name} onChange={(e) => setName(e.target.value)} />
            <Input id="name-help" label="With helper" placeholder="optional" helper="Shown to the room — not stored." value="" onChange={() => undefined} />
            <Input id="name-err" label="With error" value={bad} onChange={(e) => setBad(e.target.value)} error="Must be 1–40 chars." />
            <Input id="name-dis" label="Disabled" value="—" onChange={() => undefined} disabled />
          </div>
        </Section>

        <Section title="Badges">
          <Badge>Neutral</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="warning" icon={<TriangleAlert size={12} />}>Low confidence</Badge>
          <Badge variant="success" icon={<Check size={12} />}>Voted</Badge>
          <Badge variant="error">Disconnected</Badge>
          <Badge variant="neutral" icon={<Users size={12} />}>5 voters</Badge>
          <Badge variant="accent" icon={<Eye size={12} />}>Host</Badge>
        </Section>
      </div>
    </main>
  );
}

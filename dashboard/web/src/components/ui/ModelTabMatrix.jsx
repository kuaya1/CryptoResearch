import * as Tabs from '@radix-ui/react-tabs';

// The models as one segmented control: a light housing, each segment the
// model's name and its grade pill on one line, the chosen one a white segment
// lifted by a hairline shadow. Radix keeps the tab keyboard (Left, Right,
// Home, End) and the selection; the pill carries every research state in
// words (Waiting, Working, Check, Failed, Withheld), never only a figure.
// Render inside a Tabs.Root that owns the chosen value and its panel.
export function ModelTabMatrix({ models, label = 'Model' }) {
  return (
    <Tabs.List className="mtabs tmatrix" aria-label={label}>
      {models.map((m) => (
        <Tabs.Trigger key={m.key} value={m.key} className="mtab" data-key={m.dataKey} aria-label={m.aria}>
          <span className="mtab-name" aria-hidden="true"><span className="n-full">{m.name}</span><span className="n-short">{m.short || m.name}</span></span>
          {m.badge}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}

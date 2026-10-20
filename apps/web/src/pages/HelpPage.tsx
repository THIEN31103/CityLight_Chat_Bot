import { Card, CardHeader, PageHeader } from '@/components/ui';
import { ErrorCatalogTable } from '@/components/ErrorHelp';
import { useDict } from '@/i18n';
import { HELP } from '@/i18n/dict/help';

export function HelpPage() {
  const t = useDict(HELP);
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <Card>
        <CardHeader title={t.quickGuide} />
        <div className="space-y-2 p-4 text-sm leading-relaxed">
          {t.items.map((i) => (
            <p key={i.head}><b>{i.head}</b> {i.text}</p>
          ))}
        </div>
      </Card>
      <div id="errors">
        <h2 className="mb-2 text-lg font-semibold">{t.errorCodes}</h2>
        <ErrorCatalogTable />
      </div>
      <Card id="about">
        <CardHeader title={t.about} />
        <div className="p-4 text-sm">{t.aboutText}</div>
      </Card>
    </div>
  );
}

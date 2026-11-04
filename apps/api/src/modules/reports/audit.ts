// Действия аудита модуля reports (K2 «Отчёты Э4»; K24 §5, §7). Новый код – только правкой K2.
// export.created (Э0, K2 «Экспорт») не регистрируется здесь: в Э4 постановка экспорта – export.requested.
export const auditActions = [
  'export.requested', // отчёт, фильтры, формат, detail, маска да/нет
  'export.downloaded',
  'export.failed',
  'export.cancelled', // отмена задачи автором, K11 №247 (D4-05)
  'client.searched', // поиск CRM по телефону; номер – в поле phone, маскируется redact (K2 PD_KEYS)
] as const;

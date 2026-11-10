// Центр уведомлений ЛК: типы ответа API без браузерного кода – их импортируют остров NotificationCenter и мок tests/mock-notifications.ts
// (мок собирает и корневой tsc без DOM – tests/core/mock-vs-api-routes.test.ts).
/** Центр уведомлений ЛК (K5 №201–204, notifications/inbox.ts): строка и страница – как отдаёт API; общие для острова и мока. */
export interface InboxItem {
  id: string; title: string; body: string; category: 'service' | 'reminder' | 'marketing'; kind: string; at: string; read: boolean; url: string | null;
  booking: { id: string; state: 'active' | 'cancelled' | 'finished' | 'unavailable' } | null;
}
export interface InboxPage { items: InboxItem[]; nextCursor: string | null; unread: number }

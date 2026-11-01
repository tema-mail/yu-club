// Действия аудита модуля booking (K2 §Реестр). Брони добавятся шагами S1-07…S1-10.
export const auditActions = ['block.created', 'block.lifted', 'hold.expired', 'booking.created'] as const;

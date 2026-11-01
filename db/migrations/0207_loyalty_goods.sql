-- 0207_loyalty_goods: товары за баллы – каталог, наличие по филиалам, выдача (model-dannyh §0207, K15 §6, 07 §7, шаг S2-39).
-- Модуль-владелец – loyalty. Цены в рублях и в баллах – отдельные поля без пересчёта (07 §7.1). Выдача – только целиком
-- (Q-47), списание баллов – запись K3 loyalty.spend_goods (spend_entry_id), невыданный товар – возврат в исходные партии
-- (return_entry_id NULL, если всё «не возвращено» из-за истёкших партий). Удаления нет: товар уходит в архив.
-- Сверх нормативного DDL (решение): индекс каталога филиала, заказы клиента по времени; у yu_app отозван DELETE.

-- migrate:up
CREATE TABLE app.loyalty_goods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  image_url text,
  price_rub_kop bigint CHECK (price_rub_kop >= 0),
  price_points_centi bigint NOT NULL CHECK (price_points_centi > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  row_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.loyalty_goods_branches (
  goods_id uuid NOT NULL REFERENCES app.loyalty_goods(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  stock int CHECK (stock >= 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (goods_id, branch_id)
);
CREATE INDEX loyalty_goods_branches_branch_idx ON app.loyalty_goods_branches (branch_id) WHERE active;

CREATE TABLE app.loyalty_goods_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_id uuid NOT NULL REFERENCES app.loyalty_goods(id),
  branch_id uuid NOT NULL REFERENCES app.branches(id),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  price_points_centi bigint NOT NULL CHECK (price_points_centi > 0),
  spend_entry_id bigint NOT NULL UNIQUE REFERENCES journal.ledger_entries(id),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','returned')),
  return_entry_id bigint REFERENCES journal.ledger_entries(id),
  return_reason text,
  issued_by uuid NOT NULL, issued_at timestamptz NOT NULL,
  CHECK (status <> 'returned' OR return_reason IS NOT NULL)
);
CREATE INDEX loyalty_goods_orders_client_idx ON app.loyalty_goods_orders (client_id, issued_at);

REVOKE DELETE, TRUNCATE ON app.loyalty_goods, app.loyalty_goods_branches, app.loyalty_goods_orders FROM yu_app;

-- migrate:down
DROP TABLE app.loyalty_goods_orders;
DROP TABLE app.loyalty_goods_branches;
DROP TABLE app.loyalty_goods;

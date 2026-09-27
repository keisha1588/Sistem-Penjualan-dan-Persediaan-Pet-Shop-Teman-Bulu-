-- Teman Bulu Pet Shop: five core entities for a small sales system.
create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 100),
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null unique check (char_length(trim(name)) between 1 and 120),
  category text not null default 'Lainnya',
  price numeric(12, 2) not null check (price > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory (
  product_id uuid primary key references public.products(id) on delete cascade,
  purchase_price numeric(12, 2) not null check (purchase_price >= 0),
  selling_price numeric(12, 2) not null check (selling_price > 0),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  initial_stock_seeded boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.inventory add column if not exists initial_stock_seeded boolean not null default false;

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null default 'Pelanggan umum',
  total_amount numeric(14, 2) not null default 0 check (total_amount >= 0),
  total_profit numeric(14, 2),
  created_at timestamptz not null default now()
);

create table if not exists public.sale_details (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price > 0),
  unit_cost numeric(12, 2),
  line_total numeric(14, 2) generated always as (quantity * unit_price) stored,
  line_profit numeric(14, 2) generated always as (quantity * (unit_price - unit_cost)) stored,
  created_at timestamptz not null default now()
);

alter table public.sales add column if not exists total_profit numeric(14, 2);
alter table public.sale_details add column if not exists unit_cost numeric(12, 2);
alter table public.sale_details add column if not exists line_profit numeric(14, 2)
  generated always as (quantity * (unit_price - unit_cost)) stored;

create index if not exists sales_created_at_idx on public.sales (created_at desc);
create index if not exists sale_details_sale_id_idx on public.sale_details (sale_id);

create or replace function public.refresh_sale_total()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  affected_sale_id uuid;
begin
  if tg_op = 'DELETE' then affected_sale_id := old.sale_id;
  else affected_sale_id := new.sale_id;
  end if;

  update public.sales as s
  set total_amount = coalesce((
        select sum(d.line_total) from public.sale_details as d where d.sale_id = affected_sale_id
      ), 0),
      total_profit = (
        select case
          when count(*) = 0 then 0
          when bool_and(d.unit_cost is not null) then sum(d.line_profit)
          else null
        end
        from public.sale_details as d
        where d.sale_id = affected_sale_id
      )
  where s.id = affected_sale_id;

  if tg_op = 'UPDATE' and old.sale_id is distinct from new.sale_id then
    update public.sales as s
    set total_amount = coalesce((
          select sum(d.line_total) from public.sale_details as d where d.sale_id = old.sale_id
        ), 0),
        total_profit = (
          select case
            when count(*) = 0 then 0
            when bool_and(d.unit_cost is not null) then sum(d.line_profit)
            else null
          end
          from public.sale_details as d
          where d.sale_id = old.sale_id
        )
    where s.id = old.sale_id;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists sale_details_refresh_total on public.sale_details;
create trigger sale_details_refresh_total
after insert or update or delete on public.sale_details
for each row execute function public.refresh_sale_total();

create or replace function public.create_sale(p_customer_id uuid, p_items jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_sale_id uuid;
  sale_customer_name text;
  item record;
  product_row public.products%rowtype;
  inventory_row public.inventory%rowtype;
begin
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Pesanan harus memiliki minimal satu produk.';
  end if;

  if p_customer_id is null then
    sale_customer_name := 'Pelanggan umum';
  else
    select name into sale_customer_name from public.customers where id = p_customer_id;
    if not found then
      raise exception 'Pelanggan tidak ditemukan.';
    end if;
  end if;

  insert into public.sales (customer_id, customer_name)
  values (p_customer_id, sale_customer_name)
  returning id into new_sale_id;

  for item in
    select product_id, quantity
    from jsonb_to_recordset(p_items) as line(product_id uuid, quantity integer)
  loop
    if item.product_id is null or item.quantity is null or item.quantity < 1 then
      raise exception 'Produk dan jumlah pesanan tidak valid.';
    end if;

    select * into product_row from public.products where id = item.product_id;
    if not found then
      raise exception 'Produk tidak ditemukan.';
    end if;

    select * into inventory_row
    from public.inventory
    where product_id = item.product_id
    for update;
    if not found then raise exception 'Persediaan produk % belum diatur.', product_row.name; end if;
    if inventory_row.stock_quantity < item.quantity then
      raise exception 'Stok % tidak cukup. Tersisa %.', product_row.name, inventory_row.stock_quantity;
    end if;

    insert into public.sale_details (sale_id, product_id, product_name, quantity, unit_price, unit_cost)
    values (new_sale_id, product_row.id, product_row.name, item.quantity,
      inventory_row.selling_price, inventory_row.purchase_price);

    update public.inventory
    set stock_quantity = stock_quantity - item.quantity, updated_at = now()
    where product_id = item.product_id;
  end loop;

  return new_sale_id;
end;
$$;

create or replace function public.create_product(
  p_sku text,
  p_name text,
  p_category text,
  p_purchase_price numeric,
  p_selling_price numeric,
  p_stock_quantity integer
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_product_id uuid;
begin
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 then
    raise exception 'Nama produk wajib diisi (maksimal 120 karakter).';
  end if;
  if p_category is null or char_length(trim(p_category)) not between 1 and 40 then
    raise exception 'Kategori produk tidak valid.';
  end if;
  if p_purchase_price is null or p_purchase_price < 0 or p_selling_price is null or p_selling_price <= 0 then
    raise exception 'Harga beli tidak boleh negatif dan harga jual harus lebih dari nol.';
  end if;
  if p_stock_quantity is null or p_stock_quantity < 0 then
    raise exception 'Stok awal tidak boleh negatif.';
  end if;

  insert into public.products (sku, name, category, price)
  values (p_sku, trim(p_name), trim(p_category), p_selling_price)
  returning id into new_product_id;

  insert into public.inventory (product_id, purchase_price, selling_price, stock_quantity, initial_stock_seeded)
  values (new_product_id, p_purchase_price, p_selling_price, p_stock_quantity, true);

  return new_product_id;
end;
$$;

create or replace function public.update_inventory(
  p_product_id uuid,
  p_purchase_price numeric,
  p_selling_price numeric,
  p_stock_quantity integer
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_purchase_price is null or p_purchase_price < 0 or p_selling_price is null or p_selling_price <= 0 then
    raise exception 'Harga beli tidak boleh negatif dan harga jual harus lebih dari nol.';
  end if;
  if p_stock_quantity is null or p_stock_quantity < 0 then
    raise exception 'Stok tidak boleh negatif.';
  end if;

  update public.products set price = p_selling_price where id = p_product_id;
  if not found then raise exception 'Produk tidak ditemukan.'; end if;

  update public.inventory
  set purchase_price = p_purchase_price,
      selling_price = p_selling_price,
      stock_quantity = p_stock_quantity,
      initial_stock_seeded = true,
      updated_at = now()
  where product_id = p_product_id;
  if not found then raise exception 'Persediaan produk belum tersedia.'; end if;
end;
$$;

-- This starter app intentionally allows anonymous shop staff access. Tighten these
-- policies or add Supabase Auth before exposing a production database publicly.
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.inventory enable row level security;
alter table public.sales enable row level security;
alter table public.sale_details enable row level security;

drop policy if exists "shop staff manage customers" on public.customers;
create policy "shop staff manage customers" on public.customers for all to anon, authenticated using (true) with check (true);
drop policy if exists "shop staff manage products" on public.products;
create policy "shop staff manage products" on public.products for all to anon, authenticated using (true) with check (true);
drop policy if exists "shop staff manage inventory" on public.inventory;
create policy "shop staff manage inventory" on public.inventory for all to anon, authenticated using (true) with check (true);
drop policy if exists "shop staff manage sales" on public.sales;
create policy "shop staff manage sales" on public.sales for all to anon, authenticated using (true) with check (true);
drop policy if exists "shop staff manage sale details" on public.sale_details;
create policy "shop staff manage sale details" on public.sale_details for all to anon, authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.customers, public.products, public.inventory, public.sales, public.sale_details to anon, authenticated;
grant execute on function public.create_sale(uuid, jsonb) to anon, authenticated;
grant execute on function public.create_product(text, text, text, numeric, numeric, integer) to anon, authenticated;
grant execute on function public.update_inventory(uuid, numeric, numeric, integer) to anon, authenticated;

insert into public.products (sku, name, category, price) values
  ('MAK-KUC-001', 'Meow Mix Adult 1kg', 'Makanan', 68000),
  ('MAK-KUC-002', 'Royal Canin Kitten 400g', 'Makanan', 92000),
  ('MAK-ANJ-001', 'Pedigree Adult 1kg', 'Makanan', 57000),
  ('CAM-KUC-001', 'Treat Salmon Bites 60g', 'Camilan', 28500),
  ('CAM-ANJ-001', 'Dental Chew Medium 3pcs', 'Camilan', 32000),
  ('RAW-KUC-001', 'Pasir Tofu Green Tea 6L', 'Perawatan', 48000),
  ('RAW-UMU-001', 'Shampoo Pet Gentle 250ml', 'Perawatan', 39500),
  ('AKS-KUC-001', 'Kalung Kucing Bell', 'Aksesori', 24500),
  ('MAI-UMU-001', 'Mainan Bola Interaktif', 'Mainan', 35000),
  ('AKS-ANJ-001', 'Tali Anjing Nylon 1.5m', 'Aksesori', 62000)
on conflict (sku) do nothing;

-- Seeded and pre-existing products receive editable estimated cost and varied demo stock.
insert into public.inventory (product_id, purchase_price, selling_price, stock_quantity, initial_stock_seeded)
select id, round(price * 0.7, 2), price,
  case sku
    when 'MAK-KUC-001' then 18
    when 'MAK-KUC-002' then 0
    when 'MAK-ANJ-001' then 4
    when 'CAM-KUC-001' then 26
    when 'CAM-ANJ-001' then 2
    when 'RAW-KUC-001' then 0
    when 'RAW-UMU-001' then 11
    when 'AKS-KUC-001' then 3
    when 'MAI-UMU-001' then 32
    when 'AKS-ANJ-001' then 6
    else 0
  end,
  true
from public.products
on conflict (product_id) do nothing;

-- One-time update for zero-stock seed rows created by the previous schema version.
update public.inventory as i
set stock_quantity = case
      when i.stock_quantity <> 0 then i.stock_quantity
      else case p.sku
        when 'MAK-KUC-001' then 18
        when 'MAK-KUC-002' then 0
        when 'MAK-ANJ-001' then 4
        when 'CAM-KUC-001' then 26
        when 'CAM-ANJ-001' then 2
        when 'RAW-KUC-001' then 0
        when 'RAW-UMU-001' then 11
        when 'AKS-KUC-001' then 3
        when 'MAI-UMU-001' then 32
        when 'AKS-ANJ-001' then 6
        else i.stock_quantity
      end
    end,
    initial_stock_seeded = true,
    updated_at = now()
from public.products as p
where p.id = i.product_id
  and p.sku in ('MAK-KUC-001', 'MAK-KUC-002', 'MAK-ANJ-001', 'CAM-KUC-001', 'CAM-ANJ-001', 'RAW-KUC-001', 'RAW-UMU-001', 'AKS-KUC-001', 'MAI-UMU-001', 'AKS-ANJ-001')
  and not i.initial_stock_seeded;

update public.products as p
set price = i.selling_price
from public.inventory as i
where i.product_id = p.id and p.price is distinct from i.selling_price;

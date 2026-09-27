const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Content-Type": "application/json"
};

const allowedCollections = new Set(["customers", "products"]);
const backendUrl = Deno.env.get("https://bmchyhsnobhzpirjkgrx.supabase.co")?.replace(/\/$/, "");
const anonKey = Deno.env.get("sb_publishable_WnxyeoezhN56TcIYzj3Row_ktt76AJk");

function respond(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function validText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

async function databaseRequest(path, request, method, body) {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
  const response = await fetch(`${backendUrl}/rest/v1/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data?.message || data?.details || data?.hint || "Database request failed.";
    throw new Error(message);
  }
  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!backendUrl || !anonKey) return respond({ error: "Supabase function secrets are not configured." }, 500);

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const endpoint = segments.at(-1) === "petshop" ? "" : segments.at(-1);
  const id = segments.at(-1) === "petshop" ? null : segments.at(-1);

  try {
    if (request.method === "GET" && endpoint === "customers") {
      return respond(await databaseRequest("customers?select=id,name,phone,email,created_at&order=name.asc", request, "GET"));
    }
    if (request.method === "GET" && endpoint === "products") {
      return respond(await databaseRequest("products?select=id,sku,name,category,price,created_at,inventory(purchase_price,selling_price,stock_quantity)&order=name.asc", request, "GET"));
    }
    if (request.method === "GET" && endpoint === "sales") {
      return respond(await databaseRequest("sales?select=id,customer_name,total_amount,total_profit,created_at,sale_details(id,product_name,quantity,unit_price,unit_cost,line_total,line_profit)&order=created_at.desc", request, "GET"));
    }

    if (request.method === "POST" && endpoint === "customers") {
      const input = await request.json();
      if (!validText(input.name, 100)) return respond({ error: "Nama pelanggan wajib diisi (maksimal 100 karakter)." }, 400);
      return respond(await databaseRequest("customers", request, "POST", {
        name: input.name.trim(), phone: input.phone || null, email: input.email || null
      }), 201);
    }

    if (request.method === "POST" && endpoint === "products") {
      const input = await request.json();
      if (!validText(input.name, 120) || !validText(input.category, 40) ||
          !Number.isFinite(Number(input.purchase_price)) || Number(input.purchase_price) < 0 ||
          !Number.isFinite(Number(input.selling_price)) || Number(input.selling_price) <= 0 ||
          !Number.isInteger(Number(input.stock_quantity)) || Number(input.stock_quantity) < 0) {
        return respond({ error: "Nama, harga beli/jual, dan stok produk harus valid." }, 400);
      }
      const sku = `USR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      return respond(await databaseRequest("rpc/create_product", request, "POST", {
        p_sku: sku,
        p_name: input.name.trim(),
        p_category: input.category.trim(),
        p_purchase_price: Number(input.purchase_price),
        p_selling_price: Number(input.selling_price),
        p_stock_quantity: Number(input.stock_quantity)
      }), 201);
    }

    if (request.method === "POST" && endpoint === "inventory") {
      const input = await request.json();
      if (typeof input.product_id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.product_id) ||
          !Number.isFinite(Number(input.purchase_price)) || Number(input.purchase_price) < 0 ||
          !Number.isFinite(Number(input.selling_price)) || Number(input.selling_price) <= 0 ||
          !Number.isInteger(Number(input.stock_quantity)) || Number(input.stock_quantity) < 0) {
        return respond({ error: "Harga beli/jual atau jumlah stok tidak valid." }, 400);
      }
      return respond(await databaseRequest("rpc/update_inventory", request, "POST", {
        p_product_id: input.product_id,
        p_purchase_price: Number(input.purchase_price),
        p_selling_price: Number(input.selling_price),
        p_stock_quantity: Number(input.stock_quantity)
      }));
    }

    if (request.method === "POST" && endpoint === "sales") {
      const input = await request.json();
      if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
        return respond({ error: "Pesanan harus berisi 1 sampai 100 baris produk." }, 400);
      }
      for (const item of input.items) {
        if (typeof item.product_id !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1) {
          return respond({ error: "Produk atau jumlah pesanan tidak valid." }, 400);
        }
      }
      const result = await databaseRequest("rpc/create_sale", request, "POST", {
        p_customer_id: input.customer_id || null,
        p_items: input.items
      });
      return respond({ id: result }, 201);
    }

    if (request.method === "DELETE" && id && allowedCollections.has(segments.at(-2))) {
      const collection = segments.at(-2);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return respond({ error: "ID data tidak valid." }, 400);
      const removed = await databaseRequest(`${collection}?id=eq.${encodeURIComponent(id)}`, request, "DELETE");
      if (!removed?.length) return respond({ error: "Data tidak ditemukan." }, 404);
      return respond({ deleted: true });
    }

    return respond({ error: "Endpoint tidak ditemukan." }, 404);
  } catch (error) {
    return respond({ error: error.message || "Terjadi kesalahan saat mengakses database." }, 400);
  }
});

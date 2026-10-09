const defaultSupabaseConfig = {
  projectUrl: "https://bmchyhsnobhzpirjkgrx.supabase.co",
  anonKey: "sb_publishable_WnxyeoezhN56TcIYzj3Row_ktt76AJk"
};

const state = {
  projectUrl: defaultSupabaseConfig.projectUrl,
  anonKey: defaultSupabaseConfig.anonKey,
  customers: [],
  products: [],
  sales: [],
  cart: [],
  toastTimer: null
};

const currency = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

function money(value) {
  return currency.format(Number(value) || 0).replace(/\s/g, "");
}

function localDate(value, options = {}) {
  return new Date(value).toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric", ...options
  });
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function salesForSelectedMonth() {
  const selectedMonth = byId("sales-month").value || currentMonthKey();
  return state.sales.filter((sale) => {
    const date = new Date(sale.created_at);
    const saleMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return saleMonth === selectedMonth;
  });
}

function showToast(message, error = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("toast-error", error);
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setFeedback(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle("error", error);
}

async function api(path, options = {}) {
  if (!state.projectUrl || !state.anonKey) throw new Error("Hubungkan Supabase terlebih dahulu.");
  const method = (options.method || "GET").toUpperCase();
  let restPath = path.replace(/^\//, "");
  let body = options.body ? JSON.parse(options.body) : undefined;

  if (method === "DELETE") {
    const match = /^\/(customers|products)\/([^/]+)$/.exec(path);
    if (!match) throw new Error("Endpoint hapus tidak valid.");
    restPath = `${match[1]}?id=eq.${encodeURIComponent(match[2])}`;
  } else if (method === "POST" && path === "/sales") {
    restPath = "rpc/create_sale";
    body = { p_customer_id: body.customer_id || null, p_items: body.items };
  } else if (method === "POST" && path === "/products") {
    restPath = "rpc/create_product";
    body = {
      p_sku: `USR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      p_name: body.name,
      p_category: body.category,
      p_purchase_price: body.purchase_price,
      p_selling_price: body.selling_price,
      p_stock_quantity: body.stock_quantity
    };
  } else if (method === "POST" && path === "/inventory") {
    restPath = "rpc/update_inventory";
    body = {
      p_product_id: body.product_id,
      p_purchase_price: body.purchase_price,
      p_selling_price: body.selling_price,
      p_stock_quantity: body.stock_quantity
    };
  }

  const response = await fetch(`${state.projectUrl.replace(/\/$/, "")}/rest/v1/${restPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: state.anonKey,
      ...(method === "POST" || method === "DELETE" ? { Prefer: "return=representation" } : {}),
      ...(options.headers || {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || result.message || `Permintaan gagal (${response.status}).`);
  if (method === "POST" && path === "/sales") return { id: result };
  return result;
}

function updateConnection(connected) {
  const status = byId("connection-status");
  status.classList.toggle("connected", connected);
  byId("connection-label").textContent = connected ? "Supabase terhubung" : "Belum terhubung";
  byId("setup-notice").hidden = connected;
}

async function loadData() {
  const [customers, products, sales] = await Promise.all([
    api("/customers"),
    api("/products?select=id,sku,name,category,price,created_at,inventory(purchase_price,selling_price,stock_quantity)&order=name.asc"),
    api("/sales?select=id,customer_name,total_amount,total_profit,created_at,sale_details(id,product_name,quantity,unit_price,unit_cost,line_total,line_profit)&order=created_at.desc")
  ]);
  state.customers = customers;
  state.products = products.map((product) => {
    const inventory = Array.isArray(product.inventory) ? product.inventory[0] : product.inventory;
    return {
      ...product,
      purchase_price: Number(inventory?.purchase_price ?? 0),
      price: Number(inventory?.selling_price ?? product.price),
      stock_quantity: Number(inventory?.stock_quantity ?? 0)
    };
  });
  state.sales = sales;
  updateConnection(true);
  renderAll();
}

function renderAll() {
  renderCustomerOptions();
  renderProductOptions();
  renderCart();
  renderCustomers();
  renderProducts();
  renderSales();
  renderStats();
}

function renderCustomerOptions() {
  const select = byId("sale-customer");
  const selected = select.value;
  select.innerHTML = '<option value="">Pelanggan umum</option>' + state.customers
    .map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}</option>`).join("");
  if (state.customers.some((customer) => customer.id === selected)) select.value = selected;
}

function renderProductOptions() {
  const select = byId("sale-product");
  const selected = select.value;
  select.innerHTML = '<option value="">Pilih dari katalog</option>' + state.products
    .map((product) => `<option value="${escapeHtml(product.id)}" ${product.stock_quantity < 1 ? "disabled" : ""}>${escapeHtml(product.name)} - ${money(product.price)} (${product.stock_quantity} stok)</option>`).join("");
  if (state.products.some((product) => product.id === selected)) select.value = selected;
  updateSelectedPrice();
}

function updateSelectedPrice() {
  const product = state.products.find((item) => item.id === byId("sale-product").value);
  byId("sale-price").value = product ? money(product.price) : "-";
}

function renderCart() {
  const tbody = byId("cart-rows");
  if (!state.cart.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Belum ada produk di pesanan.</td></tr>';
  } else {
    tbody.innerHTML = state.cart.map((item, index) => `
      <tr>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td><span class="quantity-stepper"><button type="button" data-cart-action="decrease" data-index="${index}" aria-label="Kurangi jumlah">-</button><strong>${item.quantity}</strong><button type="button" data-cart-action="increase" data-index="${index}" aria-label="Tambah jumlah">+</button></span></td>
        <td>${money(item.price * item.quantity)}</td>
        <td><button class="remove-button" type="button" data-cart-action="remove" data-index="${index}" aria-label="Hapus ${escapeHtml(item.name)}">×</button></td>
      </tr>`).join("");
  }
  const total = cartTotal();
  const profit = cartProfit();
  const quantity = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  byId("cart-total").textContent = money(total);
  byId("summary-total").textContent = money(total);
  byId("cart-profit").textContent = money(profit);
  byId("cart-lines").textContent = String(state.cart.length);
  byId("cart-quantity-total").textContent = String(quantity);
  byId("save-sale").disabled = !state.cart.length || !state.projectUrl || state.cart.some((item) => item.quantity > item.stock_quantity);
}

function cartTotal() {
  return state.cart.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
}

function cartProfit() {
  return state.cart.reduce((sum, item) => sum + (Number(item.price) - Number(item.purchase_price)) * item.quantity, 0);
}

function renderCustomers() {
  const html = state.customers.length ? state.customers.map((customer) => `
    <tr>
      <td><strong>${escapeHtml(customer.name)}</strong><small>Ditambahkan ${localDate(customer.created_at)}</small></td>
      <td>${escapeHtml(customer.phone || "-")}</td>
      <td>${escapeHtml(customer.email || "-")}</td>
      <td><button class="delete-action" type="button" data-delete-customer="${escapeHtml(customer.id)}">Hapus</button></td>
    </tr>`).join("") : '<tr class="empty-row"><td colspan="4">Belum ada pelanggan.</td></tr>';
  byId("customer-rows").innerHTML = html;
  byId("customer-table-count").textContent = `${state.customers.length} data`;
  byId("customer-page-count").textContent = `${state.customers.length} pelanggan`;
}

function renderProducts() {
  const html = state.products.length ? state.products.map((product) => `
    <tr>
      <td><div class="product-name-cell"><span class="product-swatch">${escapeHtml(product.name.trim().charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku || "Katalog toko")}</small></div></div></td>
      <td>${escapeHtml(product.category)}</td>
      <td>${money(product.purchase_price)}</td>
      <td><strong>${money(product.price)}</strong></td>
      <td><span class="stock-pill ${product.stock_quantity < 1 ? "stock-empty" : ""}">${product.stock_quantity} unit</span></td>
      <td><button class="text-button inventory-edit" type="button" data-edit-inventory="${escapeHtml(product.id)}">Atur</button><button class="delete-action" type="button" data-delete-product="${escapeHtml(product.id)}">Hapus</button></td>
    </tr>`).join("") : '<tr class="empty-row"><td colspan="6">Belum ada produk. Jalankan seed katalog di schema.sql.</td></tr>';
  byId("product-rows").innerHTML = html;
  byId("product-table-count").textContent = `${state.products.length} data`;
  byId("product-page-count").textContent = `${state.products.length} produk`;
}

function saleRows(sales, limit = Infinity, detailed = false) {
  if (!sales.length) return `<tr class="empty-row"><td colspan="${detailed ? 5 : 6}">Belum ada transaksi.</td></tr>`;
  return sales.slice(0, limit).map((sale) => {
    const items = (sale.sale_details || []).map((detail) => `${escapeHtml(detail.product_name)} × ${detail.quantity}`).join(", ") || "-";
    const time = localDate(sale.created_at, { hour: "2-digit", minute: "2-digit" });
    const profit = sale.total_profit == null ? "<small>Data lama</small>" : `<strong>${money(sale.total_profit)}</strong>`;
    return detailed
      ? `<tr><td>${time}</td><td><strong>${escapeHtml(sale.customer_name || "Pelanggan umum")}</strong></td><td>${items}</td><td><strong>${money(sale.total_amount)}</strong></td><td>${profit}</td></tr>`
      : `<tr><td>${time}</td><td><strong>${escapeHtml(sale.customer_name || "Pelanggan umum")}</strong></td><td>${items}</td><td><strong>${money(sale.total_amount)}</strong></td><td>${profit}</td><td></td></tr>`;
  }).join("");
}

function renderSales() {
  byId("recent-sales").innerHTML = state.sales.length ? saleRows(state.sales, 5) : '<tr class="empty-row"><td colspan="6">Belum ada transaksi.</td></tr>';
  const monthlySales = salesForSelectedMonth();
  byId("history-sales").innerHTML = monthlySales.length
    ? saleRows(monthlySales, Infinity, true)
    : '<tr class="empty-row"><td colspan="5">Tidak ada transaksi pada bulan ini.</td></tr>';
  byId("history-count").textContent = `${monthlySales.length} transaksi`;
  byId("monthly-sale-count").textContent = String(monthlySales.length);
  byId("monthly-revenue").textContent = money(monthlySales.reduce((sum, sale) => sum + Number(sale.total_amount), 0));
  const calculatedProfitSales = monthlySales.filter((sale) => sale.total_profit != null);
  const unknownProfitCount = monthlySales.length - calculatedProfitSales.length;
  byId("monthly-profit").textContent = money(calculatedProfitSales.reduce((sum, sale) => sum + Number(sale.total_profit), 0));
  byId("monthly-profit-note").textContent = calculatedProfitSales.length
    ? `${calculatedProfitSales.length} dihitung${unknownProfitCount ? `, ${unknownProfitCount} tanpa data modal` : ""}`
    : "Belum ada data profit";
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportMonthlyReport() {
  const monthlySales = salesForSelectedMonth();
  if (!monthlySales.length) return showToast("Tidak ada transaksi untuk bulan yang dipilih.");

  const rows = [["Waktu", "Pelanggan", "Produk", "Jumlah", "Harga jual", "Harga beli", "Subtotal", "Profit kotor"]];
  monthlySales.forEach((sale) => {
    (sale.sale_details || []).forEach((detail) => rows.push([
      localDate(sale.created_at, { hour: "2-digit", minute: "2-digit" }),
      sale.customer_name || "Pelanggan umum",
      detail.product_name,
      detail.quantity,
      detail.unit_price,
      detail.unit_cost,
      detail.line_total,
      detail.line_profit
    ]));
  });

  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `rekap-penjualan-${byId("sales-month").value || currentMonthKey()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(blobUrl);
  showToast("Rekap CSV berhasil dibuat.");
}

function renderStats() {
  const today = new Date().toLocaleDateString("en-CA");
  const todaySales = state.sales.filter((sale) => new Date(sale.created_at).toLocaleDateString("en-CA") === today);
  const calculatedProfitSales = todaySales.filter((sale) => sale.total_profit != null);
  byId("today-revenue").textContent = money(todaySales.reduce((sum, sale) => sum + Number(sale.total_amount), 0));
  byId("today-profit").textContent = money(calculatedProfitSales.reduce((sum, sale) => sum + Number(sale.total_profit), 0));
  byId("today-profit-note").textContent = calculatedProfitSales.length
    ? `${calculatedProfitSales.length} transaksi dihitung`
    : "Belum ada data profit";
  byId("today-count").textContent = todaySales.length ? `${todaySales.length} transaksi hari ini` : "Belum ada transaksi";
  byId("total-sales").textContent = String(state.sales.length);
  byId("total-customers").textContent = String(state.customers.length);
  byId("product-count").textContent = `${state.products.length} produk aktif`;
}

function setView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  const active = document.querySelector(`.nav-item[data-view="${name}"]`);
  byId("page-crumb").textContent = active ? active.textContent.trim().replace(/^\d+/, "").trim() : "Ringkasan";
  window.location.hash = name;
}

function addProductToCart() {
  const product = state.products.find((item) => item.id === byId("sale-product").value);
  const quantity = Number(byId("sale-quantity").value);
  if (!product) return setFeedback("sale-feedback", "Pilih produk dari katalog terlebih dahulu.", true);
  if (!Number.isInteger(quantity) || quantity < 1) return setFeedback("sale-feedback", "Jumlah minimal 1.", true);
  const existing = state.cart.find((item) => item.id === product.id);
  const nextQuantity = (existing?.quantity || 0) + quantity;
  if (nextQuantity > product.stock_quantity) {
    return setFeedback("sale-feedback", `Stok ${product.name} hanya ${product.stock_quantity} unit.`, true);
  }
  if (existing) existing.quantity += quantity;
  else state.cart.push({
    id: product.id,
    name: product.name,
    price: Number(product.price),
    purchase_price: Number(product.purchase_price),
    stock_quantity: Number(product.stock_quantity),
    quantity
  });
  byId("sale-quantity").value = "1";
  setFeedback("sale-feedback", "Produk ditambahkan ke pesanan.");
  renderCart();
}

async function saveSale() {
  const button = byId("save-sale");
  button.disabled = true;
  setFeedback("sale-feedback", "Menyimpan penjualan...");
  try {
    await api("/sales", {
      method: "POST",
      body: JSON.stringify({
        customer_id: byId("sale-customer").value || null,
        items: state.cart.map((item) => ({ product_id: item.id, quantity: item.quantity }))
      })
    });
    state.cart = [];
    await loadData();
    setFeedback("sale-feedback", "Penjualan berhasil disimpan.");
    showToast("Penjualan tersimpan.");
  } catch (error) {
    setFeedback("sale-feedback", error.message, true);
    button.disabled = false;
  }
}

async function submitCustomer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  setFeedback("customer-feedback", "Menyimpan...");
  try {
    await api("/customers", { method: "POST", body: JSON.stringify({
      name: byId("customer-name").value.trim(),
      phone: byId("customer-phone").value.trim() || null,
      email: byId("customer-email").value.trim() || null
    }) });
    form.reset();
    await loadData();
    setFeedback("customer-feedback", "Pelanggan berhasil disimpan.");
    showToast("Pelanggan ditambahkan.");
  } catch (error) { setFeedback("customer-feedback", error.message, true); }
}

async function submitProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  setFeedback("product-feedback", "Menyimpan...");
  try {
    await api("/products", { method: "POST", body: JSON.stringify({
      name: byId("product-name").value.trim(),
      category: byId("product-category").value,
      purchase_price: Number(byId("product-purchase-price").value),
      selling_price: Number(byId("product-selling-price").value),
      stock_quantity: Number(byId("product-stock").value)
    }) });
    form.reset();
    await loadData();
    setFeedback("product-feedback", "Produk berhasil disimpan.");
    showToast("Produk ditambahkan ke katalog.");
  } catch (error) { setFeedback("product-feedback", error.message, true); }
}

function openInventoryEditor(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;
  byId("inventory-product-id").value = product.id;
  byId("inventory-product-name").textContent = product.name;
  byId("inventory-purchase-price").value = String(product.purchase_price);
  byId("inventory-selling-price").value = String(product.price);
  byId("inventory-stock").value = String(product.stock_quantity);
  setFeedback("inventory-feedback", "");
  byId("inventory-dialog").showModal();
}

async function submitInventory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  setFeedback("inventory-feedback", "Menyimpan...");
  try {
    await api("/inventory", { method: "POST", body: JSON.stringify({
      product_id: byId("inventory-product-id").value,
      purchase_price: Number(byId("inventory-purchase-price").value),
      selling_price: Number(byId("inventory-selling-price").value),
      stock_quantity: Number(byId("inventory-stock").value)
    }) });
    await loadData();
    form.reset();
    byId("inventory-dialog").close();
    showToast("Persediaan berhasil diperbarui.");
  } catch (error) { setFeedback("inventory-feedback", error.message, true); }
}

async function deleteRecord(type, id) {
  const isCustomer = type === "customers";
  const label = isCustomer ? "pelanggan" : "produk";
  if (!window.confirm(`Hapus ${label} ini? Riwayat penjualan tetap dipertahankan.`)) return;
  try {
    await api(`/${type}/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.cart = state.cart.filter((item) => item.id !== id);
    await loadData();
    showToast(`${label.charAt(0).toUpperCase()}${label.slice(1)} berhasil dihapus.`);
  } catch (error) { showToast(error.message, true); }
}

function openSettings() {
  byId("project-url").value = state.projectUrl;
  byId("anon-key").value = state.anonKey;
  setFeedback("settings-feedback", "");
  byId("settings-dialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const url = byId("project-url").value.trim().replace(/\/$/, "");
  const key = byId("anon-key").value.trim();
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) return setFeedback("settings-feedback", "Masukkan Project URL Supabase yang valid.", true);
  state.projectUrl = url;
  state.anonKey = key;
  setFeedback("settings-feedback", "Menguji koneksi...");
  try {
    await loadData();
    localStorage.setItem("teman-bulu-supabase", JSON.stringify({ projectUrl: url, anonKey: key }));
    byId("settings-dialog").close();
    showToast("Supabase berhasil dihubungkan.");
  } catch (error) {
    updateConnection(false);
    setFeedback("settings-feedback", error.message, true);
  }
}

function setDateLabels() {
  const now = new Date();
  byId("date-label").textContent = now.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  byId("today-label").textContent = now.toLocaleDateString("id-ID", { weekday: "long", day: "2-digit", month: "long" }).toUpperCase();
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.goView)));
  byId("open-settings").addEventListener("click", openSettings);
  byId("notice-settings").addEventListener("click", openSettings);
  byId("settings-form").addEventListener("submit", saveSettings);
  byId("sales-month").addEventListener("change", renderSales);
  byId("export-monthly-report").addEventListener("click", exportMonthlyReport);
  byId("sale-product").addEventListener("change", updateSelectedPrice);
  byId("add-to-cart").addEventListener("click", addProductToCart);
  byId("save-sale").addEventListener("click", saveSale);
  byId("customer-form").addEventListener("submit", submitCustomer);
  byId("product-form").addEventListener("submit", submitProduct);
  byId("inventory-form").addEventListener("submit", submitInventory);
  byId("cart-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-cart-action]");
    if (!button) return;
    const item = state.cart[Number(button.dataset.index)];
    if (!item) return;
    if (button.dataset.cartAction === "remove") state.cart.splice(Number(button.dataset.index), 1);
    if (button.dataset.cartAction === "increase") {
      if (item.quantity >= item.stock_quantity) {
        return setFeedback("sale-feedback", `Stok ${item.name} hanya ${item.stock_quantity} unit.`, true);
      }
      item.quantity += 1;
    }
    if (button.dataset.cartAction === "decrease") {
      item.quantity -= 1;
      if (item.quantity < 1) state.cart.splice(Number(button.dataset.index), 1);
    }
    renderCart();
  });
  byId("customer-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-customer]");
    if (button) deleteRecord("customers", button.dataset.deleteCustomer);
  });
  byId("product-rows").addEventListener("click", (event) => {
    const inventoryButton = event.target.closest("[data-edit-inventory]");
    if (inventoryButton) return openInventoryEditor(inventoryButton.dataset.editInventory);
    const button = event.target.closest("[data-delete-product]");
    if (button) deleteRecord("products", button.dataset.deleteProduct);
  });
  window.addEventListener("hashchange", () => {
    const view = window.location.hash.slice(1);
    setView(["dashboard", "customers", "products", "history"].includes(view) ? view : "dashboard");
  });
}

async function init() {
  bindEvents();
  setDateLabels();
  byId("sales-month").value = currentMonthKey();
  try {
    const saved = localStorage.getItem("teman-bulu-supabase");
    if (saved) {
      const config = JSON.parse(saved);
      state.projectUrl = config.projectUrl || defaultSupabaseConfig.projectUrl;
      state.anonKey = config.anonKey || defaultSupabaseConfig.anonKey;
    }
    await loadData();
  } catch (error) {
    updateConnection(false);
    showToast(error.message || "Tidak dapat terhubung ke Supabase.", true);
  }
  const initialView = window.location.hash.slice(1);
  if (["dashboard", "customers", "products", "history"].includes(initialView)) setView(initialView);
}

init().catch((error) => {
  updateConnection(false);
  showToast(error.message || "Tidak dapat memuat data.", true);
});

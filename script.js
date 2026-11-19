'use strict';
/*
 * NOVA – Modern E-commerce Store · a complete full-stack app in two files: index.html and script.js
 *
 * RUN:  node script.js            (Node 18+ and a reachable MongoDB)   →   http://localhost:5000
 * ENV (all optional):
 *   MONGO_URI       default mongodb://127.0.0.1:27017/nova      PORT         default 5000
 *   JWT_SECRET      signing key for login tokens (random per start if unset)
 *   ADMIN_EMAIL / ADMIN_PASSWORD   first admin account (a random password is printed if unset)
 *   TRUST_PROXY=1   set when running behind a reverse proxy so rate limiting sees real client IPs
 *
 * The same file runs in two places:
 *   • Node.js → the BACKEND section starts an Express + MongoDB server that serves index.html and the
 *               browser part of this file.
 *   • Browser → the FRONTEND section runs the storefront. The server removes the backend section
 *               before sending the file, so visitors never receive server code.
 */
/*<BACKEND>*/
/* ==========================================================================
 *  BACKEND  (runs only in Node.js)
 *
 *   1. Configuration            6. Business helpers
 *   2. Dependency loading       7. API routes (auth, products, cart, orders, inquiries, admin)
 *   3. Database models          8. Seed data
 *   4. Validation helpers       9. Web server and start-up
 *   5. Middleware
 * ========================================================================== */
function startBackend() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const childProcess = require('child_process');
  const crypto = require('crypto');
  const { createRequire } = require('module');

  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error('NOVA needs Node.js 18 or newer.');
    process.exit(1);
  }

  /* ------------------------------------------------------------------------
   * 1. CONFIGURATION — environment variables only; no secrets live in this file
   * ---------------------------------------------------------------------- */
  const PORT = Number(process.env.PORT) || 5000;
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nova';
  const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
  if (!process.env.JWT_SECRET) console.warn('! JWT_SECRET not set – using a random secret; logins reset when the server restarts.');

  const JWT_EXPIRES_IN = '7d';
  const BCRYPT_ROUNDS = 12;               // work factor: higher = slower to brute-force
  const CATEGORIES = ['Electronics', 'Fashion', 'Accessories', 'Home & Living'];
  const ORDER_STATUSES = ['Placed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
  const FREE_SHIPPING_MIN = 999;          // keep in sync with the storefront
  const SHIPPING_FEE = 99;
  const MAX_QTY_PER_ITEM = 10;
  const MAX_CART_LINES = 50;

  /* ------------------------------------------------------------------------
   * 2. DEPENDENCY LOADING
   * This project ships as two files, so there is no package.json. On first run the packages below are
   * installed once into the OS temp folder (not next to this file) and loaded from there.
   * ---------------------------------------------------------------------- */
  function loadDependencies() {
    const installDir = process.env.NOVA_DEPS_DIR || path.join(os.tmpdir(), 'nova-deps');
    const versions = { express: '4.19.2', mongoose: '8.4.0', jsonwebtoken: '9.0.2', bcryptjs: '2.4.3' };
    fs.mkdirSync(installDir, { recursive: true });
    const requireFromInstallDir = createRequire(path.join(installDir, 'resolver.js'));

    const isInstalled = name => { try { requireFromInstallDir.resolve(name); return true; } catch { return false; } };
    if (!Object.keys(versions).every(isInstalled)) {
      console.log(`First run: installing dependencies into ${installDir} …`);
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = childProcess.spawnSync(
        npm,
        ['install', '--prefix', installDir, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error',
          ...Object.entries(versions).map(([name, version]) => `${name}@${version}`)],
        { stdio: 'inherit', shell: process.platform === 'win32' },
      );
      if (result.status !== 0) {
        console.error('Dependency install failed. Check your internet connection and that npm is installed.');
        process.exit(1);
      }
    }
    return {
      express: requireFromInstallDir('express'),
      mongoose: requireFromInstallDir('mongoose'),
      jwt: requireFromInstallDir('jsonwebtoken'),
      bcrypt: requireFromInstallDir('bcryptjs'), // pure-JS implementation of bcrypt (no native build needed)
    };
  }
  const { express, mongoose, jwt, bcrypt } = loadDependencies();
  const { Schema, model, Types } = mongoose;

  /* ------------------------------------------------------------------------
   * 3. DATABASE MODELS (Mongoose schemas also validate data before it is saved)
   * ---------------------------------------------------------------------- */
  const addressSchema = new Schema(
    { fullName: String, phone: String, street: String, city: String, state: String, pincode: String },
    { _id: false },
  );

  const User = model('User', new Schema({
    name: { type: String, required: [true, 'Name is required'], trim: true, minlength: 2, maxlength: 60 },
    email: { type: String, required: [true, 'Email is required'], unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false }, // bcrypt hash; never returned unless asked for
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    address: { type: addressSchema, default: {} },
  }, { timestamps: true }));

  const Product = model('Product', new Schema({
    name: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 120 },
    description: { type: String, required: [true, 'Description is required'], maxlength: 2000 },
    price: { type: Number, required: [true, 'Price is required'], min: [0, 'Price cannot be negative'] },
    originalPrice: { type: Number, min: 0 },
    category: { type: String, enum: { values: CATEGORIES, message: 'Invalid category' }, required: true },
    image: { type: String, required: [true, 'Image URL is required'] },
    rating: { type: Number, min: 0, max: 5, default: 4 },
    stock: { type: Number, min: [0, 'Stock cannot be negative'], default: 0 },
    featured: { type: Boolean, default: false },
    trending: { type: Boolean, default: false },
  }, { timestamps: true }));

  // Order lines copy the product name/price at purchase time, so later price changes don't rewrite history.
  const Order = model('Order', new Schema({
    user: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    items: [{ product: { type: Types.ObjectId, ref: 'Product' }, name: String, price: Number, image: String, qty: Number, _id: false }],
    address: addressSchema,
    subtotal: Number,
    shipping: Number,
    total: Number,
    paymentMethod: { type: String, enum: ['card', 'upi', 'cod'], required: true },
    paymentStatus: { type: String, enum: ['paid', 'pending', 'refunded'], default: 'pending' }, // simulated, no real gateway
    status: { type: String, enum: ORDER_STATUSES, default: 'Placed' },
  }, { timestamps: true }));

  // One saved cart per signed-in user, mirrored from the browser's localStorage cart.
  const Cart = model('Cart', new Schema({
    user: { type: Types.ObjectId, ref: 'User', unique: true, required: true },
    items: [{ product: { type: Types.ObjectId, ref: 'Product' }, qty: { type: Number, min: 1, max: MAX_QTY_PER_ITEM }, _id: false }],
  }, { timestamps: true }));

  // Newsletter signups and contact-form messages; admins read them in the Inbox tab.
  const Inquiry = model('Inquiry', new Schema({
    type: { type: String, enum: ['newsletter', 'contact'], required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 120 },
    name: { type: String, trim: true, maxlength: 60 },
    message: { type: String, trim: true, maxlength: 1000 },
  }, { timestamps: true }));

  /* ------------------------------------------------------------------------
   * 4. VALIDATION HELPERS — every request body is checked here before it reaches the database
   * ---------------------------------------------------------------------- */
  /** An Error that carries the HTTP status the error handler should reply with. */
  const createHttpError = (status, message) => Object.assign(new Error(message), { status });

  const isTextBetween = (min, max) => value => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
  const isValidEmail = value => typeof value === 'string' && value.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const isStrongPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 72 && /[A-Za-z]/.test(value) && /\d/.test(value);
  const isObjectId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
  const isNumeric = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
  const isHttpUrl = value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // so user search text can't act as a regex

  /** Copies only the listed keys, so clients can't set fields (like `role`) we don't expect. */
  const pickFields = (source, keys) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));

  const ADDRESS_FIELDS = ['fullName', 'phone', 'street', 'city', 'state', 'pincode'];
  const PRODUCT_FIELDS = ['name', 'description', 'price', 'originalPrice', 'category', 'image', 'rating', 'stock', 'featured', 'trending'];

  /** Validates a delivery address and returns a clean copy; throws a 400 describing the first problem. */
  function parseDeliveryAddress(rawAddress) {
    const address = pickFields(rawAddress, ADDRESS_FIELDS);
    for (const field of ADDRESS_FIELDS) {
      if (!isTextBetween(2, 120)(String(address[field] ?? ''))) throw createHttpError(400, `Address field "${field}" is required`);
    }
    if (!/^\d{10}$/.test(address.phone) || !/^\d{6}$/.test(address.pincode)) {
      throw createHttpError(400, 'Enter a valid 10-digit phone and 6-digit pincode');
    }
    return Object.fromEntries(ADDRESS_FIELDS.map(field => [field, String(address[field]).trim()]));
  }

  /**
   * Validates product input from the admin panel and converts it to the right types.
   * With `partial: true` (updates) only the fields that were sent are checked.
   */
  function parseProductInput(body, { partial = false } = {}) {
    const input = pickFields(body, PRODUCT_FIELDS);
    const problems = [];
    const check = (field, isValid, message, { optional = false } = {}) => {
      const wasSent = field in input;
      if ((partial || optional) ? (wasSent && !isValid(input[field])) : !isValid(input[field])) problems.push(message);
    };
    check('name', isTextBetween(2, 120), 'Name must be 2-120 characters');
    check('description', isTextBetween(10, 2000), 'Description must be 10-2000 characters');
    check('category', value => CATEGORIES.includes(value), `Category must be one of: ${CATEGORIES.join(', ')}`);
    check('image', isHttpUrl, 'Image must be a valid http(s) URL');
    check('price', value => isNumeric(value) && Number(value) >= 0, 'Price must be a number, 0 or more');
    check('stock', value => isNumeric(value) && Number.isInteger(Number(value)) && Number(value) >= 0, 'Stock must be a whole number, 0 or more');
    check('originalPrice', value => isNumeric(value) && Number(value) >= 0, 'Original price must be a number, 0 or more', { optional: true });
    check('rating', value => isNumeric(value) && Number(value) >= 0 && Number(value) <= 5, 'Rating must be between 0 and 5', { optional: true });
    if (problems.length) throw createHttpError(400, problems.join('. '));

    for (const field of ['price', 'originalPrice', 'stock', 'rating']) if (field in input) input[field] = Number(input[field]);
    for (const field of ['featured', 'trending']) if (field in input) input[field] = input[field] === true || input[field] === 'true';
    if (!partial && !(input.originalPrice >= input.price)) input.originalPrice = input.price; // no "was" price below the current one
    return input;
  }

  /**
   * Validates a list of { product, qty } lines (used by the cart and by checkout).
   * Duplicate products are merged so the per-item limit can't be bypassed by repeating a line.
   */
  function parseLineItems(rawItems, { allowEmpty = false } = {}) {
    if (!Array.isArray(rawItems) || rawItems.length > MAX_CART_LINES || (!allowEmpty && rawItems.length === 0)) {
      throw createHttpError(400, 'Your cart is empty or invalid');
    }
    const quantityByProduct = new Map();
    for (const item of rawItems) {
      const productId = String(item?.product);
      const qty = Number(item?.qty);
      if (!isObjectId(productId)) throw createHttpError(400, 'One of the products in your cart is invalid');
      if (!Number.isInteger(qty) || qty < 1) throw createHttpError(400, 'Quantities must be whole numbers of 1 or more');
      quantityByProduct.set(productId, (quantityByProduct.get(productId) || 0) + qty);
    }
    for (const qty of quantityByProduct.values()) {
      if (qty > MAX_QTY_PER_ITEM) throw createHttpError(400, `You can order up to ${MAX_QTY_PER_ITEM} of each item`);
    }
    return [...quantityByProduct].map(([product, qty]) => ({ product, qty }));
  }

  /* ------------------------------------------------------------------------
   * 5. MIDDLEWARE
   * ---------------------------------------------------------------------- */
  /** Express 4 doesn't catch rejected promises; this forwards them to the error handler. */
  const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  /** validateBody({ field: [testFn, 'message'] }) → 400 listing every rule that failed. */
  const validateBody = rules => (req, res, next) => {
    const messages = Object.entries(rules)
      .filter(([field, [isValid]]) => !isValid(req.body?.[field]))
      .map(([, [, message]]) => message);
    next(messages.length ? createHttpError(400, messages.join('. ')) : undefined);
  };

  /**
   * AUTHENTICATION: reads "Authorization: Bearer <token>", verifies the JWT signature and expiry,
   * then loads the user from the database (so deleted accounts stop working immediately).
   */
  const requireAuth = asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) throw createHttpError(401, 'Please sign in');
    let payload;
    try { payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] }); }
    catch { throw createHttpError(401, 'Your session has expired — please sign in again'); }
    const user = await User.findById(payload.id);
    if (!user) throw createHttpError(401, 'This account no longer exists');
    req.user = user;
    next();
  });

  /** AUTHORIZATION: role check, always used after requireAuth. The role comes from the database, never the client. */
  const requireAdmin = (req, res, next) =>
    (req.user?.role === 'admin' ? next() : next(createHttpError(403, 'Administrator access required')));

  /** Fixed-window rate limiter per client IP (in memory; fine for a single server process). */
  function rateLimit({ maxRequests, windowMs, message = 'Too many attempts — please try again in a few minutes' }) {
    const windows = new Map(); // ip → { count, resetAt }
    setInterval(() => windows.clear(), windowMs).unref();
    return (req, res, next) => {
      const now = Date.now();
      const current = windows.get(req.ip);
      const entry = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
      entry.count += 1;
      windows.set(req.ip, entry);
      next(entry.count > maxRequests ? createHttpError(429, message) : undefined);
    };
  }
  const authLimiter = rateLimit({ maxRequests: 20, windowMs: 15 * 60 * 1000 });
  const inquiryLimiter = rateLimit({ maxRequests: 20, windowMs: 15 * 60 * 1000 });

  /** Turns any thrown error into a consistent JSON reply: { "message": "..." }. */
  const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
    let status = err.status || 500;
    let message = err.message;
    if (err.name === 'ValidationError') { status = 400; message = Object.values(err.errors).map(e => e.message).join('. '); }
    else if (err.name === 'CastError') { status = 400; message = 'Invalid id or value'; }
    else if (err.code === 11000) { status = 409; message = 'That email address is already registered'; }
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'Request body is not valid JSON'; }
    else if (err.type === 'entity.too.large') { status = 413; message = 'Request body is too large'; }
    else if (status === 500) { console.error(err); message = 'Something went wrong on our side'; } // never leak internals
    res.status(status).json({ message });
  };

  /* ------------------------------------------------------------------------
   * 6. BUSINESS HELPERS
   * ---------------------------------------------------------------------- */
  const signToken = user => jwt.sign({ id: user._id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
  const toPublicUser = user => ({ id: user._id, name: user.name, email: user.email, role: user.role, address: user.address });
  // Compared against when an email is unknown, so "no such user" takes as long as "wrong password".
  const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

  const shippingFor = subtotal => (subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE);

  /** Puts stock back after a cancellation or a failed order. */
  const returnStockToInventory = lines =>
    Promise.all(lines.map(line => Product.updateOne({ _id: line.product }, { $inc: { stock: line.qty } })));

  /* ------------------------------------------------------------------------
   * 7. API ROUTES (all under /api)
   * ---------------------------------------------------------------------- */
  const apiRouter = express.Router();
  // Every ":id" in a path is checked once here, so handlers can assume it is a valid ObjectId.
  apiRouter.param('id', (req, res, next, id) => next(isObjectId(id) ? undefined : createHttpError(400, 'Invalid id')));

  /* ---- Authentication & profile ---- */

  // Register: hash the password with bcrypt, save the user, return a JWT. The role is always "user".
  apiRouter.post('/auth/register', authLimiter, validateBody({
    name: [isTextBetween(2, 60), 'Name must be 2-60 characters'],
    email: [isValidEmail, 'Enter a valid email address'],
    password: [isStrongPassword, 'Password needs 8+ characters with a letter and a number'],
  }), asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const user = await User.create({ name, email, password: await bcrypt.hash(password, BCRYPT_ROUNDS), role: 'user' });
    res.status(201).json({ token: signToken(user), user: toPublicUser(user) });
  }));

  // Login: look the user up, compare the bcrypt hash, return a JWT. Same error for unknown email and wrong password.
  apiRouter.post('/auth/login', authLimiter, validateBody({
    email: [isValidEmail, 'Enter a valid email address'],
    password: [isTextBetween(1, 72), 'Password is required'],
  }), asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.body.email.trim().toLowerCase() }).select('+password');
    const passwordMatches = await bcrypt.compare(req.body.password, user?.password ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) throw createHttpError(401, 'Invalid email or password');
    res.json({ token: signToken(user), user: toPublicUser(user) });
  }));

  apiRouter.get('/auth/me', requireAuth, (req, res) => res.json({ user: toPublicUser(req.user) }));

  apiRouter.put('/auth/me', requireAuth, validateBody({ name: [isTextBetween(2, 60), 'Name must be 2-60 characters'] }),
    asyncHandler(async (req, res) => {
      const address = pickFields(req.body.address, ADDRESS_FIELDS);
      for (const field of ADDRESS_FIELDS) {
        if (address[field] !== undefined && !isTextBetween(0, 120)(address[field])) throw createHttpError(400, `Invalid ${field}`);
      }
      req.user.name = req.body.name.trim();
      req.user.address = address;
      await req.user.save();
      res.json({ user: toPublicUser(req.user) });
    }));

  /* ---- Products & categories (reading is public, changing needs an admin) ---- */

  apiRouter.get('/categories', (req, res) => res.json({ categories: CATEGORIES }));

  // Query: q (name search), category, min / max price, sort, featured, trending, ids (comma list), limit
  apiRouter.get('/products', asyncHandler(async (req, res) => {
    const { q, category, min, max, sort, featured, trending, ids, limit } = req.query;
    const filter = {};
    if (q) filter.name = { $regex: escapeRegex(String(q).slice(0, 60)), $options: 'i' };
    if (category) filter.category = String(category);
    const priceRange = {};
    if (isNumeric(min)) priceRange.$gte = Number(min);
    if (isNumeric(max)) priceRange.$lte = Number(max);
    if (Object.keys(priceRange).length) filter.price = priceRange;
    if (featured === 'true') filter.featured = true;
    if (trending === 'true') filter.trending = true;
    if (ids) filter._id = { $in: String(ids).split(',').filter(isObjectId).slice(0, 50) };

    const sortOptions = {
      'price-asc': { price: 1 }, 'price-desc': { price: -1 }, rating: { rating: -1 },
      newest: { createdAt: -1 }, featured: { featured: -1, rating: -1 },
    };
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
    res.json({ products: await Product.find(filter).sort(sortOptions[sort] || sortOptions.featured).limit(pageSize) });
  }));

  apiRouter.get('/products/:id', asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw createHttpError(404, 'Product not found');
    const related = await Product.find({ category: product.category, _id: { $ne: product._id } }).limit(4);
    res.json({ product, related });
  }));

  apiRouter.post('/products', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    res.status(201).json({ product: await Product.create(parseProductInput(req.body)) });
  }));

  apiRouter.put('/products/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const changes = parseProductInput(req.body, { partial: true });
    const product = await Product.findByIdAndUpdate(req.params.id, changes, { new: true, runValidators: true });
    if (!product) throw createHttpError(404, 'Product not found');
    res.json({ product });
  }));

  apiRouter.delete('/products/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    if (!(await Product.findByIdAndDelete(req.params.id))) throw createHttpError(404, 'Product not found');
    res.json({ message: 'Product deleted' });
  }));

  /* ---- Cart (the storefront keeps the live cart in localStorage and mirrors it here when signed in) ---- */

  apiRouter.get('/cart', requireAuth, asyncHandler(async (req, res) => {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
    res.json({ items: (cart?.items || []).filter(item => item.product) }); // drop lines whose product was deleted
  }));

  apiRouter.put('/cart', requireAuth, asyncHandler(async (req, res) => {
    const items = parseLineItems(req.body.items, { allowEmpty: true });
    await Cart.findOneAndUpdate({ user: req.user._id }, { items }, { upsert: true, runValidators: true });
    res.json({ message: 'Cart saved' });
  }));

  /* ---- Orders ---- */

  /**
   * Place an order. Prices and stock always come from the database, never from the browser:
   *  1. validate the address and line items
   *  2. for each line, atomically decrement stock only if enough is left (prevents overselling)
   *  3. save the order; if anything fails, put the stock back
   * Payment is simulated: card and UPI orders are marked "paid" immediately, cash on delivery stays "pending".
   */
  apiRouter.post('/orders', requireAuth, validateBody({
    paymentMethod: [value => ['card', 'upi', 'cod'].includes(value), 'Choose a valid payment method'],
  }), asyncHandler(async (req, res) => {
    const address = parseDeliveryAddress(req.body.address);
    const requestedLines = parseLineItems(req.body.items);
    const reservedLines = [];
    try {
      for (const { product: productId, qty } of requestedLines) {
        const product = await Product.findOneAndUpdate(
          { _id: productId, stock: { $gte: qty } },
          { $inc: { stock: -qty } },
          { new: true },
        );
        if (!product) throw createHttpError(409, 'An item in your cart is out of stock or no longer available');
        reservedLines.push({ product: product._id, name: product.name, price: product.price, image: product.image, qty });
      }
      const subtotal = reservedLines.reduce((sum, line) => sum + line.price * line.qty, 0);
      const shipping = shippingFor(subtotal);
      const order = await Order.create({
        user: req.user._id, items: reservedLines, address, subtotal, shipping, total: subtotal + shipping,
        paymentMethod: req.body.paymentMethod,
        paymentStatus: req.body.paymentMethod === 'cod' ? 'pending' : 'paid',
      });
      await Cart.deleteOne({ user: req.user._id });
      res.status(201).json(order);
    } catch (error) {
      await returnStockToInventory(reservedLines);
      throw error;
    }
  }));

  apiRouter.get('/orders/mine', requireAuth, asyncHandler(async (req, res) => {
    res.json({ orders: await Order.find({ user: req.user._id }).sort('-createdAt') });
  }));

  // Customers may cancel their own order while it is still "Placed"; stock goes back and paid orders are marked refunded.
  apiRouter.put('/orders/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id }); // the user filter stops people cancelling others' orders
    if (!order) throw createHttpError(404, 'Order not found');
    if (order.status !== 'Placed') throw createHttpError(409, 'Only orders that are still "Placed" can be cancelled');
    order.status = 'Cancelled';
    if (order.paymentStatus === 'paid') order.paymentStatus = 'refunded';
    await order.save();
    await returnStockToInventory(order.items);
    res.json(order);
  }));

  /* ---- Newsletter signups and contact messages (public, rate limited) ---- */

  apiRouter.post('/inquiries', inquiryLimiter, validateBody({
    type: [value => ['newsletter', 'contact'].includes(value), 'Invalid request'],
    email: [isValidEmail, 'Enter a valid email address'],
  }), asyncHandler(async (req, res) => {
    const { type, name, message } = req.body;
    const email = req.body.email.trim().toLowerCase();
    if (type === 'newsletter') {
      await Inquiry.findOneAndUpdate({ type, email }, { type, email }, { upsert: true }); // subscribing twice is harmless
    } else {
      if (!isTextBetween(2, 60)(name)) throw createHttpError(400, 'Name must be 2-60 characters');
      if (!isTextBetween(10, 1000)(message)) throw createHttpError(400, 'Message must be 10-1000 characters');
      await Inquiry.create({ type, email, name, message });
    }
    res.status(201).json({ message: 'Received' });
  }));

  /* ---- Admin (every route below needs a valid JWT AND the admin role) ---- */
  apiRouter.use('/admin', requireAuth, requireAdmin);

  apiRouter.get('/admin/stats', asyncHandler(async (req, res) => {
    const [users, products, orders, revenueResult, lowStock, recent] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Order.countDocuments(),
      Order.aggregate([{ $match: { status: { $ne: 'Cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Product.find({ stock: { $lte: 5 } }).select('name stock').sort('stock').limit(10),
      Order.find().sort('-createdAt').limit(5).populate('user', 'name'),
    ]);
    res.json({ users, products, orders, revenue: revenueResult[0]?.total || 0, lowStock, recent });
  }));

  apiRouter.get('/admin/orders', asyncHandler(async (req, res) => {
    res.json({ orders: await Order.find().sort('-createdAt').populate('user', 'name email') });
  }));
  apiRouter.get('/admin/users', asyncHandler(async (req, res) => res.json({ users: await User.find().sort('-createdAt') })));
  apiRouter.get('/admin/inquiries', asyncHandler(async (req, res) => {
    res.json({ inquiries: await Inquiry.find().sort('-createdAt').limit(200) });
  }));

  apiRouter.put('/admin/orders/:id/status', validateBody({
    status: [value => ORDER_STATUSES.includes(value), `Status must be one of: ${ORDER_STATUSES.join(', ')}`],
  }), asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) throw createHttpError(404, 'Order not found');
    if (order.status === 'Cancelled') throw createHttpError(409, 'Cancelled orders cannot be changed');
    if (req.body.status === 'Cancelled') {
      await returnStockToInventory(order.items);
      if (order.paymentStatus === 'paid') order.paymentStatus = 'refunded';
    }
    if (req.body.status === 'Delivered' && order.paymentMethod === 'cod') order.paymentStatus = 'paid'; // cash collected
    order.status = req.body.status;
    await order.save();
    res.json(order);
  }));

  apiRouter.use((req, res, next) => next(createHttpError(404, 'Route not found')));

  /* ------------------------------------------------------------------------
   * 8. SEED DATA — inserted only when the database is empty
   * ---------------------------------------------------------------------- */
  const unsplashUrl = photoId => `https://images.unsplash.com/${photoId}?w=800&q=80&auto=format&fit=crop`;
  const SEED_PRODUCTS = [
    // [name, category, price, original price, rating, stock, featured, trending, photo id, description]
    ['Wireless Over-Ear Headphones with ANC', 'Electronics', 6999, 9999, 4.6, 25, 1, 1, 'photo-1505740420928-5e560c06d30e', 'Hybrid active noise cancellation, 40-hour battery life and a fold-flat design with a hard carry case. Bluetooth 5.3 with a built-in microphone for calls.'],
    ['Fitness Smartwatch, 1.4" AMOLED', 'Electronics', 4499, 6999, 4.4, 18, 1, 0, 'photo-1546868871-7041f2a55e12', 'Always-on 1.4-inch display with heart-rate and SpO2 tracking, 100+ workout modes and up to 10 days of battery. Water resistant to 5 ATM.'],
    ['Portable Bluetooth Speaker, IPX7', 'Electronics', 2799, 3999, 4.5, 30, 0, 1, 'photo-1608043152269-423dbba4e7e1', 'Rugged waterproof speaker with a 360-degree sound field, 14 hours of playtime and a built-in carabiner loop.'],
    ['20,000 mAh Power Bank, 45W', 'Electronics', 2199, 2999, 4.3, 4, 0, 0, 'photo-1609091839311-d5365f9ff1c5', 'Charges a phone about four times or a laptop once. Two USB-C ports and one USB-A, with a slim aluminium body.'],
    ['Lightweight Running Shoes', 'Fashion', 3299, 4999, 4.5, 40, 1, 1, 'photo-1542291026-7eec264c27ff', 'Breathable knit upper, cushioned midsole and a grippy outsole for road and treadmill runs. Available true to size.'],
    ['Washed Denim Jacket', 'Fashion', 2799, 3999, 4.4, 22, 0, 1, 'photo-1576995853123-5a10305d93c0', 'Classic fit in 100% cotton denim with a soft wash, button front and two chest pockets. Layers well over a tee or hoodie.'],
    ['Heavyweight Cotton Hoodie', 'Fashion', 1799, 2499, 4.3, 55, 0, 0, 'photo-1556821840-3a63f95609a7', 'A relaxed 400 GSM brushed-fleece hoodie with a double-lined hood and ribbed cuffs. Pre-washed to limit shrinkage.'],
    ['Leather Laptop Backpack, 15.6"', 'Accessories', 3499, 4999, 4.7, 15, 1, 0, 'photo-1553062407-98eeb64c6a62', 'Full-grain leather with a padded laptop compartment, two organiser pockets and a hidden back pocket for your passport or wallet.'],
    ['Polarized Aviator Sunglasses', 'Accessories', 1299, 1999, 4.2, 60, 0, 1, 'photo-1572635196237-14b3f281503f', 'Lightweight metal frame with UV400 polarized lenses that cut glare. Comes with a hard case and cleaning cloth.'],
    ['Minimalist Stainless Steel Watch', 'Accessories', 3799, 5499, 4.5, 20, 1, 0, 'photo-1523275335684-37898b6baf30', 'Slim 40 mm case with a scratch-resistant sapphire-coated crystal, Japanese quartz movement and a genuine leather strap.'],
    ['Ceramic Vase Set of 3', 'Home & Living', 1499, 1999, 4.4, 28, 0, 0, 'photo-1578500494198-246f612d3b3d', 'Three hand-glazed matte vases in complementary heights. Watertight, so they work for fresh or dried flowers.'],
    ['Soy Wax Scented Candles, Set of 3', 'Home & Living', 899, 1299, 4.6, 70, 1, 1, 'photo-1602874801007-bd458bb1b8b6', 'Sandalwood, vanilla and cedar candles in reusable glass jars with cotton wicks. About 40 hours of burn time each.'],
    ['Chunky Knit Throw Blanket', 'Home & Living', 1899, 2599, 4.5, 35, 0, 1, 'photo-1580301762395-21ce84d00bc6', 'A soft, heavy cotton-blend throw, 130 x 170 cm. Machine washable and sized to drape over a sofa or bed.'],
  ].map(([name, category, price, originalPrice, rating, stock, featured, trending, photoId, description]) => (
    { name, category, price, originalPrice, rating, stock, featured: !!featured, trending: !!trending, image: unsplashUrl(photoId), description }
  ));

  async function seedDatabase() {
    if (!(await Product.countDocuments())) {
      await Product.insertMany(SEED_PRODUCTS);
      console.log(`Seeded ${SEED_PRODUCTS.length} products.`);
    }
    if (!(await User.exists({ role: 'admin' }))) {
      const email = (process.env.ADMIN_EMAIL || 'admin@nova.com').toLowerCase();
      const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
      await User.create({ name: 'NOVA Admin', email, role: 'admin', password: await bcrypt.hash(password, BCRYPT_ROUNDS) });
      console.log(`Admin account created → ${email} / ${process.env.ADMIN_PASSWORD ? '(password from ADMIN_PASSWORD)' : password}`);
    }
  }

  /* ------------------------------------------------------------------------
   * 9. WEB SERVER AND START-UP
   * ---------------------------------------------------------------------- */
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', apiRouter);

  // This file doubles as the browser script: the backend section is cut out before it is sent.
  const readOwnSource = () => fs.readFileSync(__filename, 'utf8');
  const getBrowserScript = () => readOwnSource().replace(/\/\*<BACKEND>\*\/[\s\S]*?\/\*<\/BACKEND>\*\//, '/* backend section omitted */');
  const INDEX_HTML_PATH = path.join(path.dirname(__filename), 'index.html');
  app.get(['/', '/index.html'], (req, res) => res.type('html').send(fs.readFileSync(INDEX_HTML_PATH)));
  app.get('/script.js', (req, res) => res.type('js').send(getBrowserScript()));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  app.use(errorHandler);

  process.on('unhandledRejection', reason => console.error('Unhandled promise rejection:', reason));

  (async () => {
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
      await seedDatabase();
      const server = app.listen(PORT, () => console.log(`NOVA is running → http://localhost:${PORT}`));
      const shutdown = () => server.close(() => mongoose.disconnect().then(() => process.exit(0)));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error('Startup failed: ' + error.message);
      if (/ECONNREFUSED|ENOTFOUND|selection/i.test(error.message)) console.error('Start MongoDB locally, or set MONGO_URI to a MongoDB Atlas connection string.');
      process.exit(1);
    }
  })();
}
/*</BACKEND>*/

/* ==========================================================================
 *  FRONTEND  (runs only in the browser)
 * ========================================================================== */
function startFrontend() {
  /* ==========================================================================
   * 1. CONSTANTS, STATE AND SMALL HELPERS
   * ======================================================================== */
  const API_BASE = '/api';
  const CATEGORIES = [
    { name: 'Electronics', blurb: 'Audio, wearables and power' },
    { name: 'Fashion', blurb: 'Everyday clothing and footwear' },
    { name: 'Accessories', blurb: 'Bags, watches and eyewear' },
    { name: 'Home & Living', blurb: 'Decor, candles and textiles' },
  ];
  const CATEGORY_NAMES = CATEGORIES.map(category => category.name);
  const ORDER_STATUSES = ['Placed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
  const FREE_SHIPPING_MIN = 999; // keep in sync with the server
  const SHIPPING_FEE = 99;
  const MAX_QUANTITY = 10;
  const DEFAULT_FILTERS = { q: '', category: '', maxPrice: '', sort: 'featured' };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const formatPrice = amount => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
  const formatDate = date => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const readForm = form => Object.fromEntries(new FormData(form));
  const shortOrderId = id => '#' + id.slice(-8).toUpperCase();
  const discountPercent = product => (product.originalPrice > product.price ? Math.round((1 - product.price / product.originalPrice) * 100) : 0);
  /** Returns a function that reads a saved address field, already escaped for use inside an HTML attribute. */
  const addressFieldReader = (address = {}) => key => escapeHtml(address[key] || '');

  /** Safe wrapper around localStorage (it can throw in private mode or when storage is full). */
  const storage = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore quota errors */ } },
  };

  /** Everything the interface needs to remember lives here. */
  const appState = {
    user: null,
    token: localStorage.getItem('nova_token'),
    cart: storage.get('nova_cart', []),       // [{ id, name, price, image, stock, qty }]
    wishlist: storage.get('nova_wish', []),   // [productId]
    filters: { ...DEFAULT_FILTERS },
    productCache: {},                         // id → product, filled by every product fetch
    adminTab: 'dashboard',
    accountTab: 'profile',
  };

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    $('#toasts').append(toast);
    setTimeout(() => toast.remove(), 3400);
  }

  /** JSON request helper: attaches the JWT and throws an Error carrying the server's message. */
  async function apiRequest(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (appState.token) headers.Authorization = 'Bearer ' + appState.token;
    const response = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
      .catch(() => { throw new Error("We can't reach the server right now. Please check your connection and try again."); });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
    return data;
  }

  async function fetchProducts(params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null));
    const { products } = await apiRequest('/products?' + query);
    products.forEach(product => (appState.productCache[product._id] = product));
    return products;
  }

  /* ==========================================================================
   * 2. MARKUP BUILDERS — small reusable templates that return HTML strings
   * ======================================================================== */
  const ICON_PATHS = {
    bag: '<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4V8Z"/><path d="m4 8 8 4 8-4M12 12v8"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  };
  const iconMarkup = (name, size = 20) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

  // Neutral placeholder shown when a product image fails to load (instead of an unrelated stock photo).
  const PLACEHOLDER_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#ebe9e3"/>' +
    '<g transform="translate(172 224)" fill="none" stroke="#9a988f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 14h48l-4 44H8L4 14Z"/><path d="M18 14a10 10 0 0 1 20 0"/></g></svg>');
  const productImageMarkup = item =>
    `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'">`;

  const starRatingMarkup = value => `<span class="star" aria-hidden="true">★</span> ${Number(value).toFixed(1)}`;
  const statusBadgeMarkup = status => `<span class="badge ${status}">${status}</span>`;
  const sectionHeadingMarkup = (title, link = '') => `<div class="section-head"><h2>${title}</h2>${link}</div>`;

  const skeletonGridMarkup = count => `
    <div class="product-grid">
      ${'<div><div class="skeleton media"></div><div class="skeleton line"></div><div class="skeleton line short"></div></div>'.repeat(count)}
    </div>`;

  const emptyStateMarkup = (iconName, title, text, action = '') => `
    <div class="empty">
      <span class="empty-icon">${iconMarkup(iconName, 28)}</span>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
      ${action}
    </div>`;
  const pageMarkup = (innerHtml, extraClasses = '') => `<div class="container section ${extraClasses}">${innerHtml}</div>`;
  const START_SHOPPING_LINK = '<a class="btn btn-primary" href="#/shop">Start shopping</a>';
  const HOME_LINK = '<a class="btn btn-primary" href="#/">Back to home</a>';

  function productCardMarkup(product) {
    const off = discountPercent(product);
    const saved = appState.wishlist.includes(product._id);
    const soldOut = product.stock < 1;
    const tag = soldOut ? '<span class="tag sold-out">Sold out</span>' : off ? `<span class="tag">${off}% off</span>` : '';
    return `
      <article class="product-card">
        <div class="product-media">
          <a href="#/product/${product._id}" aria-label="View ${escapeHtml(product.name)}">${productImageMarkup(product)}</a>
          ${tag}
          <button class="wish ${saved ? 'saved' : ''}" data-act="toggleWishlist" data-id="${product._id}" aria-pressed="${saved}"
                  aria-label="${saved ? 'Remove from' : 'Add to'} wishlist: ${escapeHtml(product.name)}">${iconMarkup('heart', 18)}</button>
        </div>
        <div class="product-info">
          <span class="product-category">${escapeHtml(product.category)}</span>
          <h3><a href="#/product/${product._id}">${escapeHtml(product.name)}</a></h3>
          <span class="rating" aria-label="Rated ${product.rating} out of 5">${starRatingMarkup(product.rating)}</span>
          <div class="price">
            <strong>${formatPrice(product.price)}</strong>${off ? `<s>${formatPrice(product.originalPrice)}</s>` : ''}
          </div>
          <button class="btn btn-outline btn-block" data-act="addToCart" data-id="${product._id}" ${soldOut ? 'disabled' : ''}>
            ${soldOut ? 'Sold out' : 'Add to cart'}
          </button>
        </div>
      </article>`;
  }
  const productGridMarkup = products => `<div class="product-grid">${products.map(productCardMarkup).join('')}</div>`;

  const categoryCardsMarkup = () => `
    <div class="category-grid">
      ${CATEGORIES.map(({ name, blurb }) => `
        <a class="category-card" href="#/shop" data-act="pickCategory" data-category="${escapeHtml(name)}">
          <h3>${name}</h3><p>${blurb}</p><span>Shop ${name.toLowerCase()} →</span>
        </a>`).join('')}
    </div>`;

  /* ==========================================================================
   * 3. CART
   * ======================================================================== */
  const cartItemCount = () => appState.cart.reduce((sum, line) => sum + line.qty, 0);
  const cartSubtotal = () => appState.cart.reduce((sum, line) => sum + line.qty * line.price, 0);
  const shippingFor = subtotal => (subtotal === 0 || subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE);

  /** Save the cart locally and, for signed-in users, mirror it to the server. */
  function persistCart() {
    storage.set('nova_cart', appState.cart);
    renderCart();
    if (appState.user) {
      const items = appState.cart.map(line => ({ product: line.id, qty: line.qty }));
      apiRequest('/cart', { method: 'PUT', body: { items } }).catch(() => { /* local cart still works if syncing fails */ });
    }
  }

  function addToCart(productId, quantity = 1) {
    const product = appState.productCache[productId];
    if (!product) return;
    const line = appState.cart.find(entry => entry.id === productId);
    const wanted = (line ? line.qty : 0) + quantity;
    if (wanted > product.stock) return showToast(product.stock ? `Only ${product.stock} in stock.` : 'This item is sold out.', 'error');
    if (wanted > MAX_QUANTITY) return showToast(`You can order up to ${MAX_QUANTITY} of each item.`, 'error');
    if (line) line.qty = wanted;
    else appState.cart.push({ id: productId, name: product.name, price: product.price, image: product.image, stock: product.stock, qty: quantity });
    persistCart();
    showToast(`${product.name} added to cart.`, 'success');
  }

  function changeQuantity(productId, delta) {
    const line = appState.cart.find(entry => entry.id === productId);
    if (!line) return;
    const next = line.qty + delta;
    if (next < 1) return removeFromCart(productId);
    if (next > Math.min(line.stock, MAX_QUANTITY)) return showToast('You have reached the maximum available quantity.', 'error');
    line.qty = next;
    persistCart();
    if (location.hash === '#/checkout') route(); // refresh the order summary
  }

  function removeFromCart(productId) {
    appState.cart = appState.cart.filter(entry => entry.id !== productId);
    persistCart();
    if (location.hash === '#/checkout') route();
  }

  const cartRowMarkup = line => `
    <div class="cart-row">
      <img src="${escapeHtml(line.image)}" alt="" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'">
      <div>
        <div class="name">${escapeHtml(line.name)}</div>
        <div class="muted">${formatPrice(line.price)}</div>
        <div class="stepper">
          <button data-act="changeQty" data-id="${line.id}" data-delta="-1" aria-label="Decrease quantity of ${escapeHtml(line.name)}">−</button>
          <output aria-live="polite">${line.qty}</output>
          <button data-act="changeQty" data-id="${line.id}" data-delta="1" aria-label="Increase quantity of ${escapeHtml(line.name)}">+</button>
        </div>
      </div>
      <div>
        <div class="line-total">${formatPrice(line.price * line.qty)}</div>
        <button class="remove-link" data-act="removeItem" data-id="${line.id}" aria-label="Remove ${escapeHtml(line.name)} from cart">Remove</button>
      </div>
    </div>`;

  function totalsMarkup() {
    const subtotal = cartSubtotal();
    const shipping = shippingFor(subtotal);
    return `
      <div class="total-line"><span>Subtotal</span><span>${formatPrice(subtotal)}</span></div>
      <div class="total-line"><span>Delivery</span><span>${shipping ? formatPrice(shipping) : 'Free'}</span></div>
      <div class="total-line grand"><span>Total</span><span>${formatPrice(subtotal + shipping)}</span></div>`;
  }

  function renderBadges() {
    const cartCount = cartItemCount();
    $('#cartCount').textContent = cartCount;
    $('#cartCount').hidden = !cartCount;
    $('#wishCount').textContent = appState.wishlist.length;
    $('#wishCount').hidden = !appState.wishlist.length;
  }

  function renderCart() {
    renderBadges();
    const body = $('#cartBody');
    const footer = $('#cartFoot');
    $('#cartTitle').textContent = cartItemCount() ? `Your cart (${cartItemCount()})` : 'Your cart';
    if (!appState.cart.length) {
      body.innerHTML = emptyStateMarkup('bag', 'Your cart is empty', 'Browse the shop and add something you like.',
        '<a class="btn btn-primary" href="#/shop" data-act="closeCart">Browse products</a>');
      footer.hidden = true;
      return;
    }
    const subtotal = cartSubtotal();
    const remaining = FREE_SHIPPING_MIN - subtotal;
    body.innerHTML = appState.cart.map(cartRowMarkup).join('');
    footer.hidden = false;
    footer.innerHTML = `
      <p class="shipping-note">${remaining > 0 ? `Add ${formatPrice(remaining)} more for free delivery.` : 'You’ve unlocked free delivery.'}</p>
      <progress class="shipping-progress" max="${FREE_SHIPPING_MIN}" value="${Math.min(subtotal, FREE_SHIPPING_MIN)}"
                aria-label="Progress towards free delivery"></progress>
      ${totalsMarkup()}
      <button class="btn btn-primary btn-block cart-checkout" data-act="goCheckout">Go to checkout</button>`;
  }

  function setDrawerOpen(open) {
    $('#drawer').classList.toggle('open', open);
    $('#overlay').classList.toggle('open', open);
    $('#drawer').setAttribute('aria-hidden', String(!open));
  }

  /** After signing in, pull the saved server cart and merge it into the local one. */
  async function mergeServerCart() {
    try {
      const { items } = await apiRequest('/cart');
      items.forEach(({ product, qty }) => {
        appState.productCache[product._id] = product;
        const alreadyInCart = appState.cart.some(line => line.id === product._id);
        if (!alreadyInCart && product.stock > 0) {
          appState.cart.push({ id: product._id, name: product.name, price: product.price, image: product.image, stock: product.stock, qty: Math.min(qty, product.stock) });
        }
      });
      persistCart();
    } catch { /* syncing is best-effort; the local cart still works */ }
  }

  /* ==========================================================================
   * 4. SESSION — the JWT is kept in localStorage; the server re-checks it on every request
   * ======================================================================== */
  function refreshNav() {
    $('#accountLabel').textContent = appState.user ? appState.user.name.split(' ')[0] : 'Sign in';
    $('#adminLink').hidden = appState.user?.role !== 'admin'; // cosmetic only; the server enforces the role
  }

  async function startSession({ token, user }) {
    appState.token = token;
    appState.user = user;
    localStorage.setItem('nova_token', token);
    refreshNav();
    await mergeServerCart();
  }

  function logout() {
    appState.token = null;
    appState.user = null;
    localStorage.removeItem('nova_token');
    refreshNav();
    showToast('You’ve been signed out.');
    location.hash = '#/';
    route();
  }

  function showAuthTab(tab) {
    $('#loginForm').hidden = tab !== 'login';
    $('#registerForm').hidden = tab !== 'register';
    $$('#authDialog [data-act=authTab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  }

  function openAuth(tab = 'login') {
    showAuthTab(tab);
    const dialog = $('#authDialog');
    if (!dialog.open) dialog.showModal();
  }

  function requireLogin(message = 'Please sign in to continue.') {
    if (appState.user) return true;
    showToast(message);
    openAuth();
    return false;
  }

  /* ==========================================================================
   * 5. VIEWS — one function per page; most are async because they load data
   * ======================================================================== */
  const viewRoot = $('#app');
  let navigationId = 0; // lets slow responses notice that the user has already moved on

  function renderView(html, title) {
    viewRoot.innerHTML = html;
    document.title = title ? `${title} — NOVA` : 'NOVA — Electronics, fashion, accessories and home';
  }
  /** Fill a placeholder only if it is still on screen (the user may have navigated away). */
  function fillIfPresent(selector, html) {
    const element = $(selector);
    if (element) element.innerHTML = html;
  }

  /* ---------- Home ---------- */
  const heroMarkup = () => `
    <section class="hero">
      <div class="container hero-grid">
        <div>
          <p class="eyebrow">New arrivals</p>
          <h1>Well-made things for everyday life.</h1>
          <p class="hero-copy">Electronics, clothing, accessories and homeware, selected for quality and priced fairly.</p>
          <div class="hero-actions">
            <a class="btn btn-light" href="#/shop">Shop all products</a>
            <a class="btn btn-ghost-light" href="#/categories">Browse categories</a>
          </div>
        </div>
        <div class="hero-image">
          <img src="https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1000&q=80&auto=format&fit=crop"
               alt="Over-ear wireless headphones" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMAGE}'">
        </div>
      </div>
    </section>`;

  const assuranceMarkup = () => `
    <section class="assurance">
      <div class="container">
        <div><strong>Free delivery</strong><span>On orders over ${formatPrice(FREE_SHIPPING_MIN)}</span></div>
        <div><strong>Pay your way</strong><span>Card, UPI or cash on delivery</span></div>
        <div><strong>Track your orders</strong><span>Status updates in your account</span></div>
      </div>
    </section>`;

  const promoMarkup = () => `
    <section class="container section section-tight">
      <div class="promo">
        <div>
          <h2>Free delivery on orders over ${formatPrice(FREE_SHIPPING_MIN)}</h2>
          <p>Add a few favourites to your cart and the delivery fee disappears.</p>
        </div>
        <a class="btn btn-light" href="#/shop">Start shopping</a>
      </div>
    </section>`;

  // These are placeholder reviews for the demo. They are labelled as such on the page and are not real customer feedback.
  const SAMPLE_REVIEWS = [
    'Sound quality that punches well above its price, with a battery that lasts the whole week.',
    'Easy checkout and clear order tracking. The jacket fit exactly as the description suggested.',
    'Tidy packaging and a product that matches its photos. Delivery was quicker than expected.',
  ];
  const sampleReviewsMarkup = () => `
    <section class="container section section-tight">
      ${sectionHeadingMarkup('Customer reviews')}
      <p class="section-note">These are sample reviews written for this demo store. They are not real customer feedback.</p>
      <div class="reviews">
        ${SAMPLE_REVIEWS.map(text => `
          <figure class="review">
            <span class="badge">Sample review</span>
            <div class="rating">${starRatingMarkup(5)}</div>
            <p>${text}</p>
            <figcaption>Demo customer</figcaption>
          </figure>`).join('')}
      </div>
    </section>`;

  const newsletterMarkup = () => `
    <section class="container section section-tight">
      <div class="newsletter">
        <div>
          <h2>Get new arrivals in your inbox</h2>
          <p class="muted">One short email when something new lands. Unsubscribe any time.</p>
        </div>
        <form data-form="newsletter" novalidate>
          <div>
            <label class="sr-only" for="newsletterEmail">Email address</label>
            <input id="newsletterEmail" name="email" type="email" placeholder="Your email address" autocomplete="email">
          </div>
          <button class="btn btn-primary">Subscribe</button>
        </form>
      </div>
    </section>`;

  async function showHome() {
    renderView(`
      ${heroMarkup()}
      ${assuranceMarkup()}
      <section class="container section">${sectionHeadingMarkup('Shop by category')}${categoryCardsMarkup()}</section>
      <section class="container section section-tight">
        ${sectionHeadingMarkup('Featured products', '<a href="#/shop">View all</a>')}
        <div id="featured">${skeletonGridMarkup(4)}</div>
      </section>
      ${promoMarkup()}
      <section class="container section section-tight">
        ${sectionHeadingMarkup('Trending now')}
        <div id="trending">${skeletonGridMarkup(4)}</div>
      </section>
      ${sampleReviewsMarkup()}
      ${newsletterMarkup()}`);
    const [featured, trending] = await Promise.all([fetchProducts({ featured: true, limit: 4 }), fetchProducts({ trending: true, limit: 4 })]);
    fillIfPresent('#featured', productGridMarkup(featured));
    fillIfPresent('#trending', productGridMarkup(trending));
  }

  const showCategories = () => renderView(pageMarkup(`
    <h1>Categories</h1>
    <p class="muted page-intro">Choose a department to start browsing.</p>
    ${categoryCardsMarkup()}`), 'Categories');

  /* ---------- Shop ---------- */
  const SORT_OPTIONS = [['featured', 'Featured'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low'], ['rating', 'Top rated'], ['newest', 'Newest']];

  const shopFiltersMarkup = filters => `
    <aside class="filters" aria-label="Filters">
      <h2 class="filter-title">Category</h2>
      <div class="chips">
        ${['', ...CATEGORY_NAMES].map(name => `
          <button type="button" class="chip ${filters.category === name ? 'active' : ''}" data-act="pickCategory"
                  data-category="${escapeHtml(name)}" aria-pressed="${filters.category === name}">${name || 'All'}</button>`).join('')}
      </div>
      <h2 class="filter-title">
        <label for="maxPrice">Max price</label>
        <span id="maxPriceLabel">${filters.maxPrice ? formatPrice(filters.maxPrice) : 'Any'}</span>
      </h2>
      <input id="maxPrice" type="range" min="500" max="10000" step="500" value="${filters.maxPrice || 10000}" data-filter="maxPrice">
      <button class="btn btn-outline btn-sm btn-block" data-act="resetFilters">Clear filters</button>
    </aside>`;

  async function showShop() {
    const filters = appState.filters;
    $('#q').value = filters.q;
    renderView(pageMarkup(`
      <h1>Shop</h1>
      <div class="shop-layout">
        ${shopFiltersMarkup(filters)}
        <div>
          <div class="results-bar">
            <p id="resultCount" class="muted">Loading…</p>
            <label>Sort by
              <select data-filter="sort">
                ${SORT_OPTIONS.map(([value, label]) => `<option value="${value}" ${filters.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
          </div>
          <div id="results">${skeletonGridMarkup(6)}</div>
        </div>
      </div>`), 'Shop');
    await loadShopResults();
  }

  async function loadShopResults() {
    const { q, category, maxPrice, sort } = appState.filters;
    const products = await fetchProducts({ q, category, max: maxPrice, sort });
    const countLabel = $('#resultCount');
    if (!countLabel) return; // the user navigated away while we were loading
    countLabel.textContent = `${products.length} ${products.length === 1 ? 'product' : 'products'}${q ? ` for “${q}”` : ''}`;
    fillIfPresent('#results', products.length
      ? productGridMarkup(products)
      : emptyStateMarkup('search', 'No products match your search', 'Try a different keyword or clear some filters.',
        '<button class="btn btn-primary" data-act="resetFilters">Clear filters</button>'));
  }

  /* ---------- Product page ---------- */
  function productDetailMarkup(product) {
    const off = discountPercent(product);
    const saved = appState.wishlist.includes(product._id);
    const stockClass = product.stock > 5 ? 'in-stock' : 'low-stock';
    const stockText = product.stock > 5 ? 'In stock' : product.stock > 0 ? `Only ${product.stock} left` : 'Currently sold out';
    return `
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="#/">Home</a> / <a href="#/shop">Shop</a> / ${escapeHtml(product.category)}</nav>
      <div class="detail">
        <div class="detail-image">${productImageMarkup(product)}</div>
        <div>
          <span class="product-category">${escapeHtml(product.category)}</span>
          <h1>${escapeHtml(product.name)}</h1>
          <span class="rating">${starRatingMarkup(product.rating)} out of 5</span>
          <div class="price">
            <strong>${formatPrice(product.price)}</strong>
            ${off ? `<s>${formatPrice(product.originalPrice)}</s><span class="off">${off}% off</span>` : ''}
          </div>
          <p class="detail-text">${escapeHtml(product.description)}</p>
          <p class="stock ${stockClass}">${stockText}</p>
          <div class="buy-row">
            <div class="stepper">
              <button data-act="detailQty" data-delta="-1" aria-label="Decrease quantity">−</button>
              <output id="detailQty" aria-live="polite">1</output>
              <button data-act="detailQty" data-delta="1" aria-label="Increase quantity">+</button>
            </div>
            <button class="btn btn-primary" data-act="addToCart" data-id="${product._id}" data-from-detail="1" ${product.stock < 1 ? 'disabled' : ''}>Add to cart</button>
            <button class="btn btn-outline" data-act="toggleWishlist" data-id="${product._id}">
              ${iconMarkup('heart', 18)}<span class="wish-label" data-id="${product._id}">${saved ? 'Saved' : 'Save for later'}</span>
            </button>
          </div>
          <p class="fine-print">Free delivery on orders over ${formatPrice(FREE_SHIPPING_MIN)}. Cash on delivery available.</p>
        </div>
      </div>`;
  }

  async function showProduct(productId) {
    const thisNavigation = navigationId;
    renderView(pageMarkup(skeletonGridMarkup(1)), 'Product');
    const { product, related } = await apiRequest('/products/' + productId);
    if (thisNavigation !== navigationId) return;
    appState.productCache[product._id] = product;
    related.forEach(item => (appState.productCache[item._id] = item));
    renderView(pageMarkup(`
      ${productDetailMarkup(product)}
      ${related.length ? `${sectionHeadingMarkup('You may also like')}${productGridMarkup(related)}` : ''}`), product.name);
  }

  /* ---------- Wishlist, About, Contact ---------- */
  async function showWishlist() {
    renderView(pageMarkup(`<h1>Wishlist</h1><div id="wishlistItems" class="page-intro">${skeletonGridMarkup(3)}</div>`), 'Wishlist');
    const products = appState.wishlist.length ? await fetchProducts({ ids: appState.wishlist.join(',') }) : [];
    fillIfPresent('#wishlistItems', products.length
      ? productGridMarkup(products)
      : emptyStateMarkup('heart', 'Your wishlist is empty', 'Tap the heart on any product to save it for later.', START_SHOPPING_LINK));
  }

  const showAbout = () => renderView(pageMarkup(`
    <h1>About NOVA</h1>
    <p>NOVA is a small online store built around one idea: everyday products should be well made and fairly priced.
       We select electronics, clothing, accessories and homeware we’d be happy to own ourselves.</p>
    <p>Delivery is free on orders over ${formatPrice(FREE_SHIPPING_MIN)}, and you can pay by card, UPI or cash on delivery.
       You can follow every order from your account page.</p>`, 'narrow prose'), 'About');

  const showContact = () => renderView(pageMarkup(`
    <h1>Contact us</h1>
    <p class="muted page-intro">Questions about an order or a product? Send us a message.</p>
    <form class="panel" data-form="contact" novalidate>
      <label for="contactName">Your name</label>
      <input id="contactName" name="name" autocomplete="name">
      <label for="contactEmail">Email</label>
      <input id="contactEmail" name="email" type="email" autocomplete="email">
      <label for="contactMessage">Message</label>
      <textarea id="contactMessage" name="message"></textarea>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary">Send message</button>
    </form>`, 'narrow-form'), 'Contact');

  /* ---------- Checkout & order confirmation ---------- */
  const deliveryFieldsMarkup = (address, defaultName) => {
    const saved = addressFieldReader(address);
    return `
      <h2>Delivery address</h2>
      <div class="row">
        <div>
          <label for="coName">Full name</label>
          <input id="coName" name="fullName" value="${saved('fullName') || escapeHtml(defaultName)}" autocomplete="name">
        </div>
        <div>
          <label for="coPhone">Mobile number</label>
          <input id="coPhone" name="phone" value="${saved('phone')}" inputmode="numeric" data-mask="digits" maxlength="10" autocomplete="tel-national">
        </div>
      </div>
      <label for="coStreet">Street address</label>
      <input id="coStreet" name="street" value="${saved('street')}" autocomplete="street-address">
      <div class="row">
        <div><label for="coCity">City</label><input id="coCity" name="city" value="${saved('city')}" autocomplete="address-level2"></div>
        <div><label for="coState">State</label><input id="coState" name="state" value="${saved('state')}" autocomplete="address-level1"></div>
      </div>
      <label for="coPincode">Pincode</label>
      <input class="input-short" id="coPincode" name="pincode" value="${saved('pincode')}" inputmode="numeric" data-mask="digits" maxlength="6" autocomplete="postal-code">`;
  };

  const paymentFieldsMarkup = () => `
    <div class="panel-split">
      <h2>Payment</h2>
      <div class="pay-options">
        ${[['card', 'Card'], ['upi', 'UPI'], ['cod', 'Cash on delivery']].map(([value, label], index) => `
          <label><input type="radio" name="paymentMethod" value="${value}" ${index === 0 ? 'checked' : ''}> ${label}</label>`).join('')}
      </div>
      <div data-pay-panel="card">
        <div class="row">
          <div>
            <label for="coCard">Card number</label>
            <input id="coCard" name="cardNumber" inputmode="numeric" placeholder="1234 5678 9012 3456" data-mask="card" autocomplete="off">
          </div>
          <div class="row">
            <div><label for="coExpiry">Expiry</label><input id="coExpiry" name="expiry" placeholder="MM/YY" data-mask="expiry" autocomplete="off"></div>
            <div><label for="coCvv">CVV</label><input id="coCvv" name="cvv" type="password" inputmode="numeric" maxlength="4" data-mask="digits" autocomplete="off"></div>
          </div>
        </div>
      </div>
      <div data-pay-panel="upi" hidden>
        <label for="coUpi">UPI ID</label>
        <input id="coUpi" name="upiId" placeholder="name@bank" autocomplete="off">
      </div>
      <p class="muted pay-note" data-pay-panel="cod" hidden>Pay in cash when your order arrives.</p>
      <p class="simulated-note">Payments are simulated in this demo. Card and UPI details stay in your browser and are never sent or stored.</p>
    </div>`;

  async function showCheckout() {
    if (!requireLogin('Please sign in to check out.')) { location.hash = '#/'; return; }
    if (!appState.cart.length) {
      return renderView(pageMarkup(emptyStateMarkup('bag', 'Your cart is empty', 'Add something to your cart before checking out.', START_SHOPPING_LINK)), 'Checkout');
    }
    const orderTotal = cartSubtotal() + shippingFor(cartSubtotal());
    renderView(pageMarkup(`
      <h1>Checkout</h1>
      <div class="checkout-layout">
        <form class="panel" data-form="checkout" novalidate>
          ${deliveryFieldsMarkup(appState.user.address, appState.user.name)}
          ${paymentFieldsMarkup()}
          <p class="form-error" role="alert"></p>
          <button class="btn btn-accent btn-block form-submit">Place order · ${formatPrice(orderTotal)}</button>
        </form>
        <div class="panel summary-panel">
          <h2>Order summary</h2>
          ${appState.cart.map(cartRowMarkup).join('')}
          <div class="summary-totals">${totalsMarkup()}</div>
        </div>
      </div>`), 'Checkout');
  }

  function showOrderConfirmation(order) {
    appState.accountTab = 'orders'; // so "View my orders" lands on the order list
    const paymentNote = order.paymentMethod === 'cod' ? 'cash on delivery' : 'simulated';
    renderView(pageMarkup(`
      <div class="confirm">
        <span class="confirm-icon">${iconMarkup('check', 30)}</span>
        <h1>Thank you, your order is placed</h1>
        <p class="muted confirm-meta">Order ${shortOrderId(order._id)} · payment ${order.paymentStatus} (${paymentNote})</p>
        <div class="panel confirm-summary">
          ${order.items.map(item => `<div class="total-line"><span>${escapeHtml(item.name)} × ${item.qty}</span><span>${formatPrice(item.price * item.qty)}</span></div>`).join('')}
          <div class="total-line"><span>Delivery</span><span>${order.shipping ? formatPrice(order.shipping) : 'Free'}</span></div>
          <div class="total-line grand"><span>Total</span><span>${formatPrice(order.total)}</span></div>
        </div>
        <a class="btn btn-primary" href="#/account">View my orders</a>
        <a class="btn btn-outline" href="#/shop">Continue shopping</a>
      </div>`), 'Order placed');
  }

  /* ---------- Account ---------- */
  const orderCardMarkup = order => `
    <article class="panel order">
      <div class="order-head">
        <div><b>${shortOrderId(order._id)}</b> <span class="muted">· placed ${formatDate(order.createdAt)}</span></div>
        ${statusBadgeMarkup(order.status)}
      </div>
      ${order.items.map(item => `<div class="total-line"><span>${escapeHtml(item.name)} × ${item.qty}</span><span>${formatPrice(item.price * item.qty)}</span></div>`).join('')}
      <div class="total-line grand"><span>Total · ${order.paymentMethod.toUpperCase()} (${order.paymentStatus})</span><span>${formatPrice(order.total)}</span></div>
      ${order.status === 'Placed' ? `
        <div class="order-actions">
          <button class="btn btn-outline btn-sm btn-danger" data-act="cancelOrder" data-id="${order._id}">Cancel order</button>
        </div>` : ''}
    </article>`;

  const profileFormMarkup = user => {
    const saved = addressFieldReader(user.address);
    return `
      <form class="panel profile-form" data-form="profile" novalidate>
        <label for="pfName">Full name</label>
        <input id="pfName" name="name" value="${escapeHtml(user.name)}" autocomplete="name">
        <label for="pfPhone">Mobile number</label>
        <input id="pfPhone" name="phone" value="${saved('phone')}" inputmode="numeric" data-mask="digits" maxlength="10">
        <label for="pfStreet">Street address</label>
        <input id="pfStreet" name="street" value="${saved('street')}">
        <div class="row">
          <div><label for="pfCity">City</label><input id="pfCity" name="city" value="${saved('city')}"></div>
          <div><label for="pfState">State</label><input id="pfState" name="state" value="${saved('state')}"></div>
        </div>
        <label for="pfPincode">Pincode</label>
        <input class="input-short" id="pfPincode" name="pincode" value="${saved('pincode')}" inputmode="numeric" data-mask="digits" maxlength="6">
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary">Save changes</button>
      </form>`;
  };

  async function showAccount() {
    if (!requireLogin('Please sign in to view your account.')) { location.hash = '#/'; return; }
    const tab = appState.accountTab;
    const tabs = [['profile', 'Profile'], ['orders', 'Order history']];
    renderView(pageMarkup(`
      <div class="account-bar">
        <div><h1>My account</h1><p class="muted">${escapeHtml(appState.user.email)}</p></div>
        <button class="btn btn-outline" data-act="logout">Sign out</button>
      </div>
      <div class="tabs">
        ${tabs.map(([key, label]) => `<button class="${key === tab ? 'active' : ''}" data-act="accountTab" data-tab="${key}">${label}</button>`).join('')}
      </div>
      <div id="accountBody">${tab === 'orders' ? skeletonGridMarkup(2) : profileFormMarkup(appState.user)}</div>`), 'My account');
    if (tab === 'orders') {
      const { orders } = await apiRequest('/orders/mine');
      fillIfPresent('#accountBody', orders.length
        ? orders.map(orderCardMarkup).join('')
        : emptyStateMarkup('box', 'No orders yet', 'When you place an order, you’ll be able to track it here.', START_SHOPPING_LINK));
    }
  }

  /* ---------- Admin (the server checks the admin role on every API call as well) ---------- */
  const adminTableMarkup = (headings, rows, emptyText) => `
    <div class="table-wrap">
      <table>
        <thead><tr>${headings.map(heading => `<th>${heading}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('') || `<tr><td colspan="${headings.length}" class="muted">${emptyText}</td></tr>`}</tbody>
      </table>
    </div>`;

  const adminDashboardMarkup = stats => `
    <div class="stat-grid">
      ${[['Revenue', formatPrice(stats.revenue)], ['Orders', stats.orders], ['Products', stats.products], ['Customers', stats.users]]
        .map(([label, value]) => `<div class="panel stat"><b>${value}</b><span>${label}</span></div>`).join('')}
    </div>
    <div class="admin-block">
      <h3>Low stock (5 or fewer)</h3>
      ${adminTableMarkup(['Product', 'Stock'],
        stats.lowStock.map(product => `<tr><td>${escapeHtml(product.name)}</td><td class="low">${product.stock}</td></tr>`),
        'Everything is well stocked.')}
    </div>
    <div class="admin-block">
      <h3>Recent orders</h3>
      ${adminTableMarkup(['Order', 'Customer', 'Total', 'Status'],
        stats.recent.map(order => `<tr><td>${shortOrderId(order._id)}</td><td>${escapeHtml(order.user?.name)}</td><td>${formatPrice(order.total)}</td><td>${statusBadgeMarkup(order.status)}</td></tr>`),
        'No orders yet.')}
    </div>`;

  const adminProductFormMarkup = () => `
    <form class="panel" id="productForm" data-form="product">
      <h2 id="productFormTitle">Add a product</h2>
      <input type="hidden" name="productId">
      <div class="row">
        <div><label for="apName">Name</label><input id="apName" name="name" required></div>
        <div><label for="apCategory">Category</label>
          <select id="apCategory" name="category">${CATEGORY_NAMES.map(name => `<option>${name}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label for="apPrice">Price (₹)</label><input id="apPrice" name="price" type="number" min="0" required></div>
        <div><label for="apOriginal">Original price (₹)</label><input id="apOriginal" name="originalPrice" type="number" min="0"></div>
      </div>
      <div class="row">
        <div><label for="apStock">Stock</label><input id="apStock" name="stock" type="number" min="0" required></div>
        <div><label for="apRating">Rating (0–5)</label><input id="apRating" name="rating" type="number" min="0" max="5" step="0.1" value="4"></div>
      </div>
      <label for="apImage">Image URL</label>
      <input id="apImage" name="image" type="url" required>
      <label for="apDescription">Description</label>
      <textarea id="apDescription" name="description" required></textarea>
      <div class="pay-options">
        <label><input type="checkbox" name="featured"> Featured</label>
        <label><input type="checkbox" name="trending"> Trending</label>
      </div>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary" id="productSubmit">Add product</button>
      <button type="button" class="btn btn-outline" data-act="clearProductForm">Clear</button>
    </form>`;

  const adminProductRowMarkup = product => `
    <tr>
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(product.category)}</td>
      <td>${formatPrice(product.price)}</td>
      <td><input class="stock-input" type="number" min="0" value="${product.stock}" data-stock-for="${product._id}" aria-label="Stock for ${escapeHtml(product.name)}"></td>
      <td class="actions-cell">
        <button class="btn btn-outline btn-sm" data-act="editProduct" data-id="${product._id}">Edit</button>
        <button class="btn btn-outline btn-sm btn-danger" data-act="deleteProduct" data-id="${product._id}">Delete</button>
      </td>
    </tr>`;

  const adminOrderRowMarkup = order => {
    const statusControl = order.status === 'Cancelled'
      ? statusBadgeMarkup(order.status)
      : `<select data-order-status="${order._id}" aria-label="Status for order ${shortOrderId(order._id)}">
           ${ORDER_STATUSES.map(status => `<option ${status === order.status ? 'selected' : ''}>${status}</option>`).join('')}
         </select>`;
    return `
      <tr>
        <td>${shortOrderId(order._id)}</td>
        <td>${escapeHtml(order.user?.name)}<br><small class="muted">${escapeHtml(order.user?.email)}</small></td>
        <td>${formatDate(order.createdAt)}</td>
        <td>${formatPrice(order.total)}</td>
        <td>${order.paymentMethod.toUpperCase()}</td>
        <td>${statusControl}</td>
      </tr>`;
  };

  const adminInboxMarkup = inquiries => inquiries.length
    ? `<div class="stack">${inquiries.map(item => `
        <article class="panel inquiry">
          <div class="order-head">
            <div><b>${escapeHtml(item.name || item.email)}</b>
              <span class="muted">${item.name ? '· ' + escapeHtml(item.email) : ''} · ${formatDate(item.createdAt)}</span></div>
            <span class="badge">${item.type === 'newsletter' ? 'Newsletter signup' : 'Message'}</span>
          </div>
          ${item.message ? `<p>${escapeHtml(item.message)}</p>` : ''}
        </article>`).join('')}</div>`
    : emptyStateMarkup('box', 'Inbox is empty', 'Contact messages and newsletter signups will appear here.');

  async function showAdmin() {
    if (appState.user?.role !== 'admin') {
      return renderView(pageMarkup(emptyStateMarkup('user', 'Admins only', 'You need an administrator account to view this page.', HOME_LINK)), 'Admin');
    }
    const tab = appState.adminTab;
    const tabs = [['dashboard', 'Dashboard'], ['products', 'Products'], ['orders', 'Orders'], ['users', 'Customers'], ['inbox', 'Inbox']];
    renderView(pageMarkup(`
      <h1>Admin</h1>
      <div class="tabs">
        ${tabs.map(([key, label]) => `<button class="${key === tab ? 'active' : ''}" data-act="adminTab" data-tab="${key}">${label}</button>`).join('')}
      </div>
      <div id="adminBody">${skeletonGridMarkup(3)}</div>`), 'Admin');
    const render = html => fillIfPresent('#adminBody', html);

    if (tab === 'dashboard') {
      render(adminDashboardMarkup(await apiRequest('/admin/stats')));
    } else if (tab === 'products') {
      const products = await fetchProducts({ limit: 100 });
      render(`${adminProductFormMarkup()}
        <div class="admin-block">${adminTableMarkup(['Product', 'Category', 'Price', 'Stock', ''], products.map(adminProductRowMarkup), 'No products yet.')}</div>`);
    } else if (tab === 'orders') {
      const { orders } = await apiRequest('/admin/orders');
      render(adminTableMarkup(['Order', 'Customer', 'Date', 'Total', 'Payment', 'Status'], orders.map(adminOrderRowMarkup), 'No orders yet.'));
    } else if (tab === 'users') {
      const { users } = await apiRequest('/admin/users');
      render(adminTableMarkup(['Name', 'Email', 'Role', 'Joined'],
        users.map(user => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${user.role}</td><td>${formatDate(user.createdAt)}</td></tr>`),
        'No customers yet.'));
    } else {
      render(adminInboxMarkup((await apiRequest('/admin/inquiries')).inquiries));
    }
  }

  /* ==========================================================================
   * 6. ROUTER — hash based: #/shop, #/product/<id>, ...
   * ======================================================================== */
  const routes = {
    '': showHome, shop: showShop, categories: showCategories, product: showProduct, wishlist: showWishlist,
    about: showAbout, contact: showContact, checkout: showCheckout, account: showAccount, admin: showAdmin,
  };

  function closeMobileMenu() {
    $('#links').classList.remove('open');
    $('[data-act=toggleMenu]').setAttribute('aria-expanded', 'false');
  }

  async function route() {
    const thisNavigation = ++navigationId;
    const [name, param] = location.hash.replace(/^#\/?/, '').split('/');
    closeMobileMenu();
    window.scrollTo(0, 0);
    $$('#links a').forEach(link => link.classList.toggle('active', link.dataset.route === (name || '')));
    const view = routes[name || ''];
    if (!view) {
      return renderView(pageMarkup(emptyStateMarkup('box', 'Page not found', 'The page you’re looking for doesn’t exist.', HOME_LINK)), 'Page not found');
    }
    try {
      await view(param);
    } catch (error) {
      if (thisNavigation === navigationId) renderView(pageMarkup(emptyStateMarkup('box', 'Something went wrong', error.message, HOME_LINK)), 'Error');
    }
  }

  /* ==========================================================================
   * 7. FORM VALIDATION AND SUBMISSION
   * ======================================================================== */
  /** Thrown by validators so the message can be shown right under the offending field. */
  class FieldError extends Error {
    constructor(field, message) { super(message); this.field = field; }
  }

  const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  const hasLength = min => value => value.trim().length >= min;
  const isDigits = count => value => new RegExp(`^\\d{${count}}$`).test(value);
  const isStrongPassword = value => value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
  const isUnexpiredCardDate = value => {
    const match = value.match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
    if (!match) return false;
    const year = 2000 + Number(match[2]), month = Number(match[1]), now = new Date();
    return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
  };

  /** rules = { fieldName: [test, message] }; throws a FieldError for the first failing field. */
  function validateFields(values, rules) {
    for (const [field, [isValid, message]] of Object.entries(rules)) {
      if (!isValid(String(values[field] ?? ''))) throw new FieldError(field, message);
    }
  }

  function clearFieldError(input) {
    if (!input.hasAttribute?.('aria-invalid')) return;
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    const note = input.nextElementSibling;
    if (note?.classList.contains('field-error')) note.remove();
  }

  function showFieldError(form, field, message) {
    const input = form.elements[field];
    if (!input || input instanceof RadioNodeList) return false;
    $$('[aria-invalid]', form).forEach(clearFieldError);
    const note = document.createElement('p');
    note.className = 'field-error';
    note.id = `error-${field}`;
    note.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', note.id);
    input.insertAdjacentElement('afterend', note);
    input.focus();
    return true;
  }

  /** Changes a form's submit-button label while it works (the submit handler restores it afterwards). */
  function setBusy(form, text) {
    const button = $('button:not([type=button])', form);
    if (button) button.textContent = text;
  }

  const formHandlers = {
    async login(form) {
      const values = readForm(form);
      validateFields(values, { email: [isEmail, 'Enter the email address you signed up with.'], password: [hasLength(1), 'Enter your password.'] });
      const session = await apiRequest('/auth/login', { method: 'POST', body: values });
      await startSession(session);
      $('#authDialog').close();
      form.reset();
      showToast(`Welcome back, ${session.user.name.split(' ')[0]}.`, 'success');
      route();
    },

    async register(form) {
      const values = readForm(form);
      validateFields(values, {
        name: [hasLength(2), 'Please enter your full name.'],
        email: [isEmail, 'Enter a valid email address.'],
        password: [isStrongPassword, 'Use at least 8 characters, including a letter and a number.'],
      });
      if (values.password !== values.confirm) throw new FieldError('confirm', 'The two passwords don’t match.');
      const session = await apiRequest('/auth/register', { method: 'POST', body: { name: values.name, email: values.email, password: values.password } });
      await startSession(session);
      $('#authDialog').close();
      form.reset();
      showToast(`Welcome to NOVA, ${session.user.name.split(' ')[0]}.`, 'success');
      route();
    },

    async profile(form) {
      const { name, ...address } = readForm(form);
      validateFields({ name }, { name: [hasLength(2), 'Please enter your full name.'] });
      if (address.phone && !isDigits(10)(address.phone)) throw new FieldError('phone', 'Enter a 10-digit mobile number.');
      if (address.pincode && !isDigits(6)(address.pincode)) throw new FieldError('pincode', 'Enter a 6-digit pincode.');
      appState.user = (await apiRequest('/auth/me', { method: 'PUT', body: { name, address } })).user;
      refreshNav();
      showToast('Your profile has been updated.', 'success');
    },

    async checkout(form) {
      const values = readForm(form);
      validateFields(values, {
        fullName: [hasLength(2), 'Enter the recipient’s full name.'],
        phone: [isDigits(10), 'Enter a 10-digit mobile number.'],
        street: [hasLength(5), 'Enter your street address.'],
        city: [hasLength(2), 'Enter your city.'],
        state: [hasLength(2), 'Enter your state.'],
        pincode: [isDigits(6), 'Enter a 6-digit pincode.'],
      });
      // Payment details are validated for realism only; they are never sent to the server.
      if (values.paymentMethod === 'card') {
        validateFields(values, {
          cardNumber: [value => isDigits(16)(value.replace(/\s/g, '')), 'Enter the 16-digit card number.'],
          expiry: [isUnexpiredCardDate, 'Enter a valid, unexpired date (MM/YY).'],
          cvv: [value => /^\d{3,4}$/.test(value), 'Enter the 3 or 4-digit security code.'],
        });
      } else if (values.paymentMethod === 'upi') {
        validateFields(values, { upiId: [value => /^[\w.-]{2,}@[\w.-]{2,}$/.test(value.trim()), 'Enter a valid UPI ID, like name@bank.'] });
      }
      setBusy(form, 'Processing payment…');
      await new Promise(resolve => setTimeout(resolve, 900)); // simulated payment processing delay
      const { fullName, phone, street, city, state, pincode } = values;
      const order = await apiRequest('/orders', {
        method: 'POST',
        body: {
          paymentMethod: values.paymentMethod,
          address: { fullName, phone, street, city, state, pincode },
          items: appState.cart.map(line => ({ product: line.id, qty: line.qty })),
        },
      });
      appState.cart = [];
      persistCart();
      appState.user.address = order.address;
      showOrderConfirmation(order);
      window.scrollTo(0, 0);
    },

    async product(form) {
      const values = readForm(form);
      const body = {
        name: values.name, description: values.description, category: values.category, image: values.image,
        price: Number(values.price), originalPrice: Number(values.originalPrice) || Number(values.price),
        stock: Number(values.stock), rating: Number(values.rating) || 4,
        featured: !!values.featured, trending: !!values.trending,
      };
      const isEditing = !!values.productId;
      await apiRequest(isEditing ? '/products/' + values.productId : '/products', { method: isEditing ? 'PUT' : 'POST', body });
      showToast(isEditing ? 'Product updated.' : 'Product added.', 'success');
      showAdmin();
    },

    async newsletter(form) {
      const { email } = readForm(form);
      validateFields({ email }, { email: [isEmail, 'Enter a valid email address.'] });
      await apiRequest('/inquiries', { method: 'POST', body: { type: 'newsletter', email } });
      form.reset();
      showToast('You’re subscribed. Thanks for joining.', 'success');
    },

    async contact(form) {
      const values = readForm(form);
      validateFields(values, {
        name: [hasLength(2), 'Please tell us your name.'],
        email: [isEmail, 'Enter a valid email address.'],
        message: [hasLength(10), 'Please write a few words so we can help (at least 10 characters).'],
      });
      await apiRequest('/inquiries', { method: 'POST', body: { type: 'contact', ...values } });
      form.reset();
      showToast('Thanks, we’ve received your message and will reply by email.', 'success');
    },
  };

  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    const button = $('button:not([type=button])', form);
    const originalLabel = button?.textContent;
    const formError = $('.form-error', form);
    $$('[aria-invalid]', form).forEach(clearFieldError);
    if (formError) formError.textContent = '';
    if (button) button.disabled = true;
    try {
      await formHandlers[form.dataset.form](form);
    } catch (error) {
      const shownOnField = error instanceof FieldError && showFieldError(form, error.field, error.message);
      if (!shownOnField) formError ? (formError.textContent = error.message) : showToast(error.message, 'error');
    } finally {
      if (button?.isConnected) { button.disabled = false; button.textContent = originalLabel; }
    }
  });

  /* ==========================================================================
   * 8. EVENTS — one delegated click listener plus input/change listeners
   * ======================================================================== */
  const goToShop = () => (location.hash === '#/shop' ? showShop() : (location.hash = '#/shop'));

  const clickActions = {
    addToCart: el => addToCart(el.dataset.id, el.dataset.fromDetail ? parseInt($('#detailQty').textContent, 10) : 1),

    toggleWishlist(el) {
      const id = el.dataset.id;
      const wasSaved = appState.wishlist.includes(id);
      appState.wishlist = wasSaved ? appState.wishlist.filter(savedId => savedId !== id) : [...appState.wishlist, id];
      storage.set('nova_wish', appState.wishlist);
      renderBadges();
      $$(`.wish[data-id="${id}"]`).forEach(button => { button.classList.toggle('saved', !wasSaved); button.setAttribute('aria-pressed', String(!wasSaved)); });
      $$(`.wish-label[data-id="${id}"]`).forEach(label => (label.textContent = wasSaved ? 'Save for later' : 'Saved'));
      showToast(wasSaved ? 'Removed from your wishlist.' : 'Saved to your wishlist.');
      if (location.hash === '#/wishlist') showWishlist();
    },

    changeQty: el => changeQuantity(el.dataset.id, Number(el.dataset.delta)),
    removeItem: el => removeFromCart(el.dataset.id),
    detailQty(el) {
      const output = $('#detailQty');
      output.textContent = Math.max(1, Math.min(MAX_QUANTITY, Number(output.textContent) + Number(el.dataset.delta)));
    },

    openCart: () => setDrawerOpen(true),
    closeCart: () => setDrawerOpen(false),
    goCheckout() {
      setDrawerOpen(false);
      if (requireLogin('Please sign in to check out.')) location.hash = '#/checkout';
    },

    account: () => (appState.user ? (location.hash = '#/account') : openAuth()),
    closeAuth: () => $('#authDialog').close(),
    authTab: el => showAuthTab(el.dataset.tab),
    logout,
    toggleMenu: el => el.setAttribute('aria-expanded', String($('#links').classList.toggle('open'))),

    pickCategory(el) {
      appState.filters.category = el.dataset.category;
      if (location.hash === '#/shop') showShop();
    },
    resetFilters() {
      appState.filters = { ...DEFAULT_FILTERS };
      $('#q').value = '';
      goToShop();
    },

    async cancelOrder(el) {
      if (!confirm('Cancel this order?')) return;
      await apiRequest(`/orders/${el.dataset.id}/cancel`, { method: 'PUT' });
      showToast('Your order has been cancelled.', 'success');
      showAccount();
    },
    accountTab(el) { appState.accountTab = el.dataset.tab; showAccount(); },

    adminTab(el) { appState.adminTab = el.dataset.tab; showAdmin(); },
    clearProductForm() {
      $('#productForm').reset();
      $('#productFormTitle').textContent = 'Add a product';
      $('#productSubmit').textContent = 'Add product';
    },
    editProduct(el) {
      const product = appState.productCache[el.dataset.id];
      const form = $('#productForm');
      ['name', 'category', 'price', 'originalPrice', 'stock', 'rating', 'image', 'description'].forEach(key => (form.elements[key].value = product[key]));
      form.elements.productId.value = product._id;
      form.elements.featured.checked = !!product.featured;
      form.elements.trending.checked = !!product.trending;
      $('#productFormTitle').textContent = 'Edit product';
      $('#productSubmit').textContent = 'Save changes';
      form.scrollIntoView({ behavior: 'smooth' });
    },
    async deleteProduct(el) {
      if (!confirm('Delete this product permanently?')) return;
      await apiRequest('/products/' + el.dataset.id, { method: 'DELETE' });
      showToast('Product deleted.', 'success');
      showAdmin();
    },
  };

  document.addEventListener('click', async event => {
    const el = event.target.closest('[data-act]');
    if (!el || !clickActions[el.dataset.act]) return;
    try { await clickActions[el.dataset.act](el); } catch (error) { showToast(error.message, 'error'); }
  });

  $('#searchForm').addEventListener('submit', event => {
    event.preventDefault();
    appState.filters.q = $('#q').value.trim();
    goToShop();
  });

  // Input masks keep phone, pincode and card fields tidy; editing a field clears its error message.
  let priceFilterTimer;
  document.addEventListener('input', event => {
    const el = event.target;
    clearFieldError(el);
    if (el.dataset.mask === 'digits') el.value = el.value.replace(/\D/g, '');
    if (el.dataset.mask === 'card') el.value = el.value.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
    if (el.dataset.mask === 'expiry') {
      const digits = el.value.replace(/\D/g, '').slice(0, 4);
      el.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    }
    if (el.dataset.filter === 'maxPrice') { // debounced so we don't query on every slider tick
      const value = Number(el.value);
      appState.filters.maxPrice = value >= 10000 ? '' : value;
      $('#maxPriceLabel').textContent = appState.filters.maxPrice ? formatPrice(value) : 'Any';
      clearTimeout(priceFilterTimer);
      priceFilterTimer = setTimeout(loadShopResults, 250);
    }
  });

  document.addEventListener('change', async event => {
    const el = event.target;
    try {
      if (el.dataset.filter === 'sort') { appState.filters.sort = el.value; loadShopResults(); }
      if (el.name === 'paymentMethod') $$('[data-pay-panel]').forEach(panel => (panel.hidden = panel.dataset.payPanel !== el.value));
      if (el.dataset.orderStatus) {
        await apiRequest(`/admin/orders/${el.dataset.orderStatus}/status`, { method: 'PUT', body: { status: el.value } });
        showToast('Order status updated.', 'success');
        showAdmin();
      }
      if (el.dataset.stockFor) {
        await apiRequest('/products/' + el.dataset.stockFor, { method: 'PUT', body: { stock: Math.max(0, Number(el.value) || 0) } });
        showToast('Stock updated.', 'success');
      }
    } catch (error) {
      showToast(error.message, 'error');
      if (el.dataset.orderStatus) showAdmin(); // put the dropdown back to the saved status
    }
  });

  window.addEventListener('keydown', event => { if (event.key === 'Escape') setDrawerOpen(false); });

  /* ==========================================================================
   * 9. START-UP
   * ======================================================================== */
  (async function init() {
    $$('[data-icon]').forEach(el => (el.innerHTML = iconMarkup(el.dataset.icon)));
    if (appState.token) {
      try {
        appState.user = (await apiRequest('/auth/me')).user;
        await mergeServerCart();
      } catch {
        appState.token = null; // expired or invalid token
        localStorage.removeItem('nova_token');
      }
    }
    refreshNav();
    renderCart();
    window.addEventListener('hashchange', route);
    route();
  })();
}

if (typeof window === 'undefined') startBackend(); else startFrontend();
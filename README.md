# Meri Dukaan

Create a shop link, and customers can order from it in any browser.
Every order is saved and an email is sent to you.

## How it works
- You open `/admin`, type your password, and create a store. You get a shop link like `/s/asha-sarees`.
- The store owner opens their manage page (`/manage?store=your-link-word`) with their store key. It works like an app on a phone: a home dashboard, products with stock and expiry, orders with delivery and payment tracking, and suppliers.
- A customer opens the shop link, adds items, enters their address, and confirms the order. There is no payment step.
- The order is saved and you get an email.

## Setup (about 30 minutes, no coding)

### 1. Put the files on GitHub
1. Make a new empty repository on github.com, under your own account (not an organisation).
2. Click **Add file → Upload files** and drag in everything from this folder, including the `public` folder.
3. Click **Commit changes**.

### 2. Firebase (the database)
1. Go to console.firebase.google.com and create a project.
2. Open **Build → Firestore Database → Create database**. Choose **production mode** and a Mumbai location if offered.
3. Open **Project settings → Service accounts → Generate new private key**. A small file downloads. Keep it private.

### 3. Email (customers log in with a code, and everyone gets order emails)
The shop sends email for three things: the **login code** customers type to sign in, **order alerts to you**, and **order updates to customers** (placed, out for delivery, delivered, cancelled). You need ONE of the two ways below. **Option A is the easiest and works for anyone, with no website domain.**

**Option A: Gmail (free, recommended).** Best to use a Gmail made just for the shop, such as `cocoacorner.shop@gmail.com`.
1. Sign in to that Gmail. Open myaccount.google.com → **Security** → turn on **2-Step Verification** (Google asks for it).
2. In the search box at the top of that page, type **App passwords** and open it. Name it "Meri Dukaan" and click **Create**.
3. Google shows a 16-letter password. Copy it (spaces don't matter).
4. In Vercel, add two variables: `SMTP_USER` = the Gmail address, `SMTP_PASS` = the 16-letter password. Optional: `FROM_EMAIL` = `Cocoa Corner <that Gmail address>`.
5. Gmail lets you send about 500 emails a day, which is plenty for a small shop.

**Option B: Resend.** Sign up at resend.com and create an API key; add it as `RESEND_API_KEY`. Until you verify your own domain in Resend, it can only send to the email you signed up with, so customers would NOT get login codes. Use this only if you own a domain.

**Where your order alerts go:** set `ADMIN_EMAIL` in Vercel to your own email. Customers can also log in only after email is set up; without email, customers can still order as guests.

### 4. Vercel (runs the website)
1. Sign up at vercel.com using **Continue with GitHub**.
2. Click **Add New → Project** and pick your repository.
3. Before you click Deploy, open **Environment Variables** and add these:
   - `FIREBASE_SERVICE_ACCOUNT`: open the downloaded Firebase file in Notepad, copy everything, paste it here.
   - `ADMIN_PASSWORD`: a long password only you know.
   - `ADMIN_EMAIL`: your email, where order alerts arrive.
   - `SMTP_USER` and `SMTP_PASS`: the Gmail address and App password from step 3 (or `RESEND_API_KEY` if you chose Resend).
4. Click **Deploy**. When it finishes, Vercel gives you a link such as `https://your-project.vercel.app`.

### 5. Try it
1. Open `your-link/admin` and log in with your password.
2. Create a store, open its manage page, and add a product.
3. In the manage page open **Account → Business details** and add your **phone** (this powers the WhatsApp button) and your **UPI ID** (this turns on the UPI option at checkout).
4. Open the shop link, tap **Account → Log in**, get a code by email, and place a test order. Check your email, then change the order's delivery status in the manage page and watch the customer's Track order screen update.

## The customer shop and how it links to the manage page
- Customers browse Home, Categories and Search, open a product, add to cart and check out with **Cash or UPI**. The checkout says delivery charges will be added in the final invoice.
- Every order lands in your **Orders** list with its payment method, email and note. When you mark an order **Packed**, **In transit**, **Delivered** or **Cancelled**, the customer's tracking steps move and they get an email.
- Tracking steps: Order Placed → Payment Confirmed (Order Confirmed for cash) → Preparing → Ready for Dispatch → Out for Delivery → Delivered. Opening a new order in the manage page marks it confirmed.
- Stock goes down when an order is placed and comes back if you cancel. Bestsellers come from real sales.
- In a product, **Crossed-out price / MRP** shows a discount on the shop and **Featured** puts it on the home page.
- Customers can review a delivered order; reviews show on the home page.

## Adding products by barcode (EAN)
- Tap **Create new → Scan barcode** (or the **Scan** button next to "Barcode / EAN" inside a product form) and point the phone camera at the barcode.
- If you already have a product with that barcode, it opens. If not, a new product form opens with the barcode filled in. For packaged food and chocolates the name and pack size are filled in too, from the free Open Food Facts list. Always check the name, then type the price and quantity and add a photo.
- No camera? Type the number, or use a USB or Bluetooth barcode scanner: click the box and scan.
- The same barcode can't be used on two products. When you bill a customer, you can type or scan the barcode into the search box to find the product.
- The camera needs the website link to start with https (Vercel does this for you) and permission to use the camera.

## Staff, tags and photos
- **Logging in:** the manage page remembers you on that phone or computer until you tap **Log out**. Owners type their password or store key and leave **Username** empty. Staff type their username and password.
- **Staff:** on the manage page open **Staff → Add a staff member**. Pick a username, a password and what they may do (add products, edit quantity and expiry, edit purchase price, assign tags, view orders). Staff log in on the same manage page by typing their username. They can never change selling prices, make products live, delete things or see sales and profit.
- **Selling price and going live:** only the owner sets these. A product added by staff starts as a draft with no price. The owner sets the price and flips the **Live** switch beside the product.
- **Tags:** the owner creates them under **Tags** and can reorder them. Staff can assign them to products. Each tag becomes a section on the online store. Products with no tag appear under "More items".
- **Photos:** up to 5 per product, uploaded from the product form. Every photo is saved on a white 1536 × 1024 canvas (3:2 landscape). The whole photo is kept, never cropped, and any extra space is filled with white. They are shrunk on the phone first and kept in Firebase, so no paid storage is needed. Photos uploaded before this update keep their old shape and are shown whole, with white space around them.
- **Colours, sizes, flavours and weights (Merge under):** add every colour or flavour as its own product, with its own photos, price and stock. In the product form, under **Variants**, choose **Merge under** and pick the main product, then type its colour and size (or flavour and weight). On the online store the products show as one listing with buttons to pick the colour and size. When a customer searches, every matching product also shows on its own, still with the buttons. The packer sees the choice on the order, for example "Tee (Blue, L)". Deleting the main product turns the others back into normal listings.
- **Orders:** each order lists its items in a line (full product name, quantity, photo on the right). **View order** opens it like a bill. Every order has a **Delivery** dropdown (New, To dispatch, In transit, Delivered, Cancelled) and, for the owner only, a **Payment** dropdown (Unpaid, Paid by Cash, UPI, Card, Bank or COD, or Part payment).
- **What staff see on orders:** only the order statuses you tick for them (New and To dispatch by default). They only get the Delivery dropdown. They never see prices, payments or invoices, and they cannot cancel. Once an order moves past what you ticked, it disappears from their screen and stays with you.
- **Editing a new order (owner):** open **Orders → In-Process**. Change each item's quantity with + and −, then tap **Confirm order** to move it to **Confirmed** (To dispatch), or **Reject** to cancel it. Stock is adjusted for you, and removed items go back into stock. A quantity can't go above what you have in stock, and an order that already has a payment recorded can't be re-quantified until it is set back to Unpaid.
- **Invoices:** the owner taps **Send invoice** on any order. It opens WhatsApp with a message and a private invoice link. The customer can open the link, print it or save it as a PDF.
- **New orders:** a red dot shows on **Orders** until you tap the order. The page checks for new orders every 30 seconds.

## The mobile screens (Home, Products, Orders, New invoice, Account)
- **Home:** your photo, greeting and name (tap to open Account), search and bell, then Overview with Today / 30 days / Year, the sales card (revenue, profit, collected), the order pipeline, Needs attention (**Reorder** opens WhatsApp to the product's supplier, using the phone number under Suppliers), recent orders, and the Online store card with your link, Copy, Share on WhatsApp and a QR code.
- **+ button:** opens **Create new** with New product and New invoice. Staff who can add products go straight to New product.
- **Products:** search by name or product code, category chips (your Tags), filter button, stock badges, and a sheet with price, cost, stock, expiry, online-store switch, **Adjust stock** and **Edit product**.
- **Orders:** In-Process, Confirmed and All. New orders can be edited and confirmed or rejected. Confirmed orders have Record payment, View invoice, Share invoice and Send reminder. Drafts live under All.
- **New invoice (owner only):** bill a counter sale (**At store**, handed over at once) or a phone order (**Online**, ready to dispatch). Pick products, payment, discount, GST and notes. Stock goes down when you tap **Create invoice**, never for a draft. The discount comes off first, then GST is added.
- **Invoices (owner):** **More → Invoices** (or the Manage card on Home) lists every invoice with its number, customer, amount, date and payment status. Filter by All, Unpaid, Paid or Cancelled, search by number, name or phone, and see what is billed, collected and still due. Each one has View, Share on WhatsApp, Remind and Delete.
- **Inventory:** **More → Inventory** (or the Manage card on Home) shows units in stock, stock value (if you may see costs), low and out-of-stock counts, and every product with its code, expiry and quantity. Tap a product to adjust its stock and say why (stock received, counted again, damaged or expired, returned). The **History** tab lists every stock change: from orders, invoices, cancellations, deletions and manual adjustments, with who did it and when. Staff who may edit quantity can use Inventory too, without seeing costs or values.
- **Delete (owner only):** any order or invoice made by mistake can be deleted from its card, the bill sheet or the Invoices list. You choose whether the items go back into stock. A copy is kept behind the scenes, and the number is not reused. Rejecting or cancelling an order keeps a record, which is usually better for tax records, so ask your accountant if unsure.
- **Order numbers** are short and count up, like MD-1045, using the first letters of your business name. Older orders keep their old numbers.
- **Account:** photo, name, email, phone, Business details (address, GSTIN, phone, usual GST rate, shop name), and Change password for staff or **Make a new store key** for you. The owner's email here is where new-order alerts go.
- **GST:** the app only does the sums you choose. Please check the rules with your accountant. Sales revenue on Home includes GST collected, and profit takes GST out.

## Import, export and purchases
- **Export / Import products:** on **Products**, tap the arrow-up button. **Export all products** downloads a CSV file you can open in Excel or Google Sheets. **Download blank template** gives just the column names. **Import from a file** shows a preview first (what is new, what is skipped, what is missing) and only saves when you tap **Import**.
- **What an import needs:** only a **name**. A row with just a name comes in as a draft marked **Needs details**. Before a product can go live it needs a selling price, a purchase price, a quantity and at least one photo. This rule applies everywhere in the app, and products that need details show on Home under **Needs attention** (and under Products → Filter → Needs details).
- **Import rules:** owner only, up to 500 rows at a time. A code (SKU) that already exists is skipped, unless you tick **Update products that already exist**. Categories that don't exist yet are created for you. Use `|` between several categories. **Merged under** can be a product code or a name. Dates can be `2026-12-31` or `31/12/2026`. Imported quantities show in the stock history as "Imported".
- **Inventory tabs:** **Stock**, **Purchase** and **Sales** (Sales is the old History list).
- **Purchases (owner only):** tap **+ → New invoice**, then choose **Purchase** at the top (Sales stays the default). Pick the supplier from your Suppliers list, add the supplier's bill number (optional), the date, the products with quantity and purchase price, the payment (Paid, Partial or Unpaid), discount and GST. **Create purchase** adds the stock and writes "Purchase PU-1001" in the stock history. By default each product's purchase price is updated to the new price (untick to keep the old one). A product typed by name that doesn't exist yet is added as a draft. **Save draft** keeps it under Inventory → Purchase.
- **Purchase tab and Invoices:** purchase cards show the first 3 products, with **View all items** when there are more. The top shows Purchased, Paid and Owed to suppliers. Use **Record payment** when you pay a supplier later. Deleting a purchase asks whether to take its stock off again. **Invoices** has a Purchase | Sales switch too.
- **View all items:** order cards with more than 3 items show 3 and a purple **View all items** link that opens the full list in a popup.
- **Sheets:** drag the little handle at the top of any bottom sheet down to close it (or tap outside it).

## Editing, expiry, stock safety and cancelled invoices
- **Edit an invoice:** owner only. Tap **Edit** on an order or on the Invoices list (also inside View order). You can change the customer, At store / Online, address, products and quantities, discount, GST and notes. Stock follows the change: removing items puts them back, adding items takes them out. Prices of items already on the invoice stay as they were; newly added items use today's price. Payments are changed with **Record payment**, and the new total can't be less than what is already paid. Cancelled invoices can't be edited.
- **Expired items:** an item whose expiry date has passed (by Indian date; the expiry day itself is still sellable) is hidden from the online shop and blocked at checkout with a clear message, even if it is already in someone's cart. It stays on your Needs attention list. On New invoice and Edit invoice it shows an **Expired** tag and asks you to confirm before adding.
- **Stock numbers stay right:** Edit product only sends the quantity if you changed it. If stock moved while the form was open (for example a customer bought something), the app says "Stock changed from 49 to 44 while you were editing" and saves nothing. **Adjust stock** now has two modes: **Add or remove** (+10 received, −2 damaged; added to the latest stock) and **Set exact count** (a recount, with the same warning if stock moved).
- **Cancelled invoices:** the invoice page shows a large red CANCELLED with the date and "Nothing to pay". Share invoice and Reminder are hidden, and **Share cancellation** replaces them. If the customer had paid, it shows **Refund due**; tap **Record refund** once you have returned the money and it changes to **Refunded**. Links you sent earlier update too.

## Look and feel, titles and WhatsApp messages
- **Light / Dark:** open **Account → Appearance** and choose **Light**, **Dark** or **Match phone** (follows your phone's own setting). It is saved on that phone only. Customers see the shop and invoice in their own phone's setting.
- **Smooth switching:** switching Today / 30 days / Year, the Orders and Inventory tabs, filters and the Purchase | Sales switch now changes the screen in place. Only moving to a different screen has a soft fade, and nothing flashes. If your phone is set to reduce motion, the animations are off.
- **Names:** the sales screen is **New Sale** (and **Edit Sale** when editing), the purchase screen is **New Purchase**, and the button says **Create sale**. The **Invoices** tab keeps its name.
- **WhatsApp messages:** the invoice, the payment reminder and the cancellation notice now use a tidy format with a greeting, the shop name, a bold order number and amount, and a plain tappable link on its own line. A reminder shows the amount still due. A counter sale says "Your purchase … is complete" and an online order says "has been received".

## Totals, big shops, and a few safety fixes
- **Home numbers stay exact:** sales, profit, collected money, the % up or down, the order pipeline, money customers owe you and money you owe suppliers come from a small set of running totals (kept under each shop as `stats/totals`). Every time an order or purchase is made, edited, paid, cancelled, refunded or deleted, the totals change in the same save. The first time Home opens after this update, the app counts your existing orders once. If a number ever looks wrong, open **Account → Safety and totals → Recalculate totals**.
- **Lists load a page at a time:** the Orders and Invoices screens show the newest 100 orders plus every order still open (new, to dispatch, in transit). **Load older orders** brings in the next 100. **Search every order** looks through all of them (it reads each order once, so use it when you really need an old one). The Unpaid views also fetch every unpaid order. Purchases work the same way.
- **Most of one item per online order:** set it in **Account → Business details** (default 20). The shop page's + button stops there and tells the customer to contact you for more; the server uses the same limit. Orders you enter yourself, and quantity changes you make, can go higher.
- **Purchase price:** a blank price is saved as empty (the product shows "Needs details" and cannot go live). Typing ₹0 asks "Is this item really free?". **Products → Filter → Purchase price missing** lists products with an empty or ₹0 price, and Home points to live ones. Old orders keep the cost they had when sold.
- **Invoice links and the admin password:** invoice links and staff logins are signed with `SESSION_SECRET`, or with your admin password if that isn't set. Add a long random `SESSION_SECRET` under Vercel → Settings → Environment Variables and redeploy, **before** you send many invoices; after that you can change the admin password safely. (If you add it later, links already sent stop working once.) Account shows a reminder until it is set.

## Updating the app later
1. Unzip the new zip file.
2. Open your repository on GitHub, click **Add file → Upload files**, and drag in everything from the new folder, including the `public` folder. Files with the same names are replaced.
3. Click **Commit changes**. Vercel notices and updates your website by itself in about a minute. Your secrets and your data stay as they are.

## Good to know
- Vercel's free plan is for personal, non-commercial use only. If you start selling store links or taking money through this, you need a paid plan.
- The site does not go to sleep for minutes like Render's free plan. The first visit after a quiet period can still take a moment.
- If you change an environment variable later, go to **Deployments** and redeploy so it takes effect.
- Never upload your Firebase file or passwords to GitHub. They only go in Vercel's Environment Variables.
- Product photos are links to images that are already online.

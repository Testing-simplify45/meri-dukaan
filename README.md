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

### 3. Resend (sends the emails)
1. Sign up at resend.com with the email where you want order alerts.
2. Create an API key and copy it.
3. Until you verify your own domain in Resend, it only delivers to the email you signed up with. Use that same email as `ADMIN_EMAIL`.

### 4. Vercel (runs the website)
1. Sign up at vercel.com using **Continue with GitHub**.
2. Click **Add New → Project** and pick your repository.
3. Before you click Deploy, open **Environment Variables** and add these four:
   - `FIREBASE_SERVICE_ACCOUNT`: open the downloaded Firebase file in Notepad, copy everything, paste it here.
   - `ADMIN_PASSWORD`: a long password only you know.
   - `ADMIN_EMAIL`: your email, same as the Resend one.
   - `RESEND_API_KEY`: the key from Resend.
4. Click **Deploy**. When it finishes, Vercel gives you a link such as `https://your-project.vercel.app`.

### 5. Try it
1. Open `your-link/admin` and log in with your password.
2. Create a store, open its manage page, and add a product.
3. Open the shop link, place a test order, and check your email.

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

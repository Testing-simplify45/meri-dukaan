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
- **Staff:** on the manage page open **Staff → Add a staff member**. Pick a username, a password and what they may do (add products, edit quantity and expiry, edit purchase price, assign tags, view orders). Staff log in on the same manage page by typing their username. They can never change selling prices, make products live, delete things or see sales and profit.
- **Selling price and going live:** only the owner sets these. A product added by staff starts as a draft with no price. The owner sets the price and flips the **Live** switch beside the product.
- **Tags:** the owner creates them under **Tags** and can reorder them. Staff can assign them to products. Each tag becomes a section on the online store. Products with no tag appear under "More items".
- **Photos:** up to 5 per product, uploaded from the product form. They are shrunk on the phone first and kept in Firebase, so no paid storage is needed.
- **Orders:** each order lists its items in a line (full product name, quantity, photo on the right). **View order** opens it like a bill. Every order has a **Delivery** dropdown (New, To dispatch, In transit, Delivered, Cancelled) and, for the owner only, a **Payment** dropdown (Unpaid, Paid by Cash, UPI, Card, Bank or COD, or Part payment).
- **What staff see on orders:** only the order statuses you tick for them (New and To dispatch by default). They only get the Delivery dropdown. They never see prices, payments or invoices, and they cannot cancel. Once an order moves past what you ticked, it disappears from their screen and stays with you.
- **Invoices:** the owner taps **Send invoice** on any order. It opens WhatsApp with a message and a private invoice link. The customer can open the link, print it or save it as a PDF.
- **New orders:** a red dot shows on **Orders** until you tap the order. The page checks for new orders every 30 seconds.

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

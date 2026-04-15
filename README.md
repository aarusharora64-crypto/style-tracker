# Style Tracker

Real-time manufacturing style tracking app with chat, notifications, and ERP dashboard.

## Quick Deploy to Render (Free)

1. Push this folder to a **GitHub repo**
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects settings from `render.yaml`
5. Click **Deploy** — your app is live in ~2 minutes

## First-Time Setup

1. Open your app URL
2. Click **"Admin? Manage team"** at the bottom of login screen
3. Default Admin PIN: `1234` (change this immediately in Admin → Settings)
4. Add your team members with their names and departments
5. Share the app URL with your team — they just pick their name and start chatting

## Features

- **Chat**: Team types style updates like "ST-101 cutting started 500 pcs" — auto-detects style number and production stage
- **Real-time sync**: All users see updates instantly, ERP dashboard updates live
- **Notifications**: In-app alerts + browser push notifications for relevant departments
- **Department filter**: See all updates or filter to your department only
- **ERP Dashboard**: Stats, search, filter, expandable timeline per style, CSV export
- **Admin Panel**: Add/remove team members, change app name, change PIN, clear data

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

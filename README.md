# Lounge – Community Chat

Lounge is a friendly, real-time community chat website. People sign up, join topic rooms, and talk with each other live. It works on both desktop and mobile.

**Live site:** https://harshit-sharma05.github.io/lounge-chat/

## Features

- Sign up and log in with validated forms
- Topic rooms with live messages (no page refresh needed)
- Private groups and invitations
- Online list showing who is currently active
- Profile photos
- Bad-word filter and message moderation tools for admins
- Dark theme, responsive layout for desktop and mobile

## Built with

| Part | Technology |
|---|---|
| Screens and layout | HTML, CSS |
| App logic | JavaScript (ES modules) |
| Login, database, live updates, photo storage | [Supabase](https://supabase.com) |
| Hosting | GitHub Pages |

## Project structure

```
index.html          Log in / Register screen
chat.html           Chat screen
css/style.css       Styles, colors and mobile layout
img/                Logo and favicon
js/
  auth-page.js      Login and register logic
  chat.js           Rooms, messages, online list, groups, admin tools
  config.js         Supabase settings and bad-word list
  supabaseClient.js Connection to Supabase
  utils.js          Helpers and form validation
supabase/schema.sql Database tables, security rules and storage setup
```

## Team and contributions

| Member | Role | Main files |
|---|---|---|
| **Harshit Sharma** | Interface design: layout, colors and responsive screens | `index.html`, `chat.html`, `css/style.css`, `img/` |
| **Ayushi Katiyar** | Chat logic: JavaScript, rooms and live messages | `js/chat.js`, `js/supabaseClient.js` |
| **Sameer Chetry** | Checks and storage: form validation and saving data | `js/auth-page.js`, `js/config.js`, `supabase/schema.sql` |

## Run it on your computer

1. Clone the repo:
   ```bash
   git clone https://github.com/Harshit-Sharma05/lounge-chat.git
   cd lounge-chat
   ```
2. Open the folder in VS Code and start it with the **Live Server** extension (Go Live).
3. Open `index.html` in the browser that opens.

The app connects to the team's Supabase project, which is set up in `js/config.js`. To use your own, create a Supabase project, run `supabase/schema.sql` in its SQL editor, and put your project URL and public key in `js/config.js`.

## Working on the project

Each member works on their own branch and opens a pull request into `team-build`:

```bash
git checkout team-build
git checkout -b your-branch-name
# make changes, then
git add .
git commit -m "Describe your change"
git push -u origin your-branch-name
```

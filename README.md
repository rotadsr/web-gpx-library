# GPX Library 🗺️

A modern, feature-rich web app for managing and visualizing GPX routes. Built with **Leaflet.js**, **Chart.js**, and **MapLibre GL JS**, entirely client-side with **IndexedDB** persistence.

Try it live: https://rotadsr.github.io/web-gpx-library/


## Features

### 📍 Route Visualization
- Interactive map with multiple tile layers (OpenStreetMap, OpenTopoMap, Esri, etc.)
- Route track display with start (🟢) and end (🔴) point markers
- Real-time elevation cursor on the map
- **3D terrain view** — real elevation extrusion powered by MapLibre GL JS; route colour-coded blue→red by altitude; elevation profile cursor synced to both 2D and 3D maps

### 📊 Detailed Route Analytics
- **Elevation profile chart** — interactive graph showing elevation vs. distance
- **Route statistics**: distance, duration, total gain, elevation range, max/min elevation, gradient, speed
- **Difficulty rating** — smart algorithm based on distance, elevation, and gradient
- **7-day weather forecast** — powered by Open-Meteo API (no key required)

### 📝 Full Route Editor
- Draw and edit track points directly on the map
- Drag points to reposition, click to select
- Undo, delete, and clear track operations
- Set activity type (25+ options: hiking, climbing, cycling, skiing, etc.)
- Raw XML editor for advanced users
- Download edited routes as GPX files

### 💾 Persistent Library
- **My Library** — save routes permanently to the browser (IndexedDB)
- **Session uploads** — temporary routes for quick preview
- **Export/import** — backup your library as JSON, restore with merge or overwrite
- **Backup reminders** — browser warns before leaving if changes aren't exported

### 🔍 Search & Filter
- Full-text search across route names and descriptions
- Semantic keyword expansion (e.g., "winter" finds all snow activities)
- Filter by activity category (hiking, cycling, water sports, etc.)
- Activity icons in sidebar for quick identification

### 🔗 Route Sharing
- **Share button** in the route header — track is automatically simplified, saved as a GitHub Gist, and a link is shown in a popup
- Copy the link with the **Copy** button or select it manually — no clipboard permission required
- Recipients open the link and the route loads automatically — no account or token needed to view
- Shared routes appear in the **Uploaded Routes** section with a banner prompting the recipient to save
- Sharers need a one-time GitHub Personal Access Token (PAT) with the `gist` scope — stored only in their browser

### ⚙️ User-Friendly Workflow
1. **Upload** a GPX file (drag & drop or click)
2. **Preview** on the interactive map with full stats
3. **Edit** if needed (redraw track, change metadata)
4. **Save** to your library (persists across browser sessions)
5. **Share** a link directly — no file attachments needed
6. **Export** for backup

## How to Use

### Online
No installation needed — just open the app in your browser (GitHub Pages link).

### Upload a Route
1. Click **"Upload GPX files"** in the left sidebar (drag & drop or click to browse)
2. Route appears in **Uploaded Routes** section
3. Click to view on the map

### Save to Library
- Click the **yellow save button** on uploaded routes, or
- Open editor → edit route → click **"Save to Library"**
- Routes persist and sync across browser restarts

### Export Your Library
- Click **"Export"** in the library header
- Downloads `gpx-library-YYYY-MM-DD.json`
- Keep as backup on your computer

### Import Previously Exported Library
- Click **"Import"** in the library header
- Select a `.json` file
- Choose **Merge** (add to existing) or **Overwrite** (replace all)

### Share a Route
- Load any route from the sidebar
- Click the **Share** button in the route header
- On first use, a prompt asks for a GitHub Personal Access Token (PAT) with the `gist` scope — [create one here](https://github.com/settings/tokens/new?scopes=gist&description=GPX+Library+Share). The token is saved in your browser's localStorage and never sent anywhere except GitHub
- The track is simplified and saved as a public GitHub Gist; a popup appears with the link
- Click **Copy** or select the link manually, then send it to anyone
- The recipient opens the link and the route loads automatically — no token required to view
- A banner prompts recipients to save the route to their local library

> **Note:** Shared links are backed by [GitHub Gist](https://gist.github.com/), which stores them permanently (until the Gist owner deletes them). Recipients should still save shared routes to their local library to ensure long-term access.

> **Track simplification:** Before sharing, the track is automatically de-spiked (GPS outliers removed) and simplified using the Ramer-Douglas-Peucker algorithm. Short routes (<10 km) are capped at 1,500 points; long routes (>20 km) at 4,000 points. The original route in your library is never modified.

### Edit a Route
- Click the **green pencil icon** on any route
- Full editor opens with map, track editor, and metadata forms
- Download as GPX when done, or save directly to library

## Tech Stack

- **Frontend**: Vanilla JavaScript (no frameworks)
- **Maps**: [Leaflet.js](https://leafletjs.com/) with free tile providers
- **3D terrain**: [MapLibre GL JS](https://maplibre.org/) with AWS Terrarium DEM tiles (free, no key)
- **Charts**: [Chart.js](https://www.chartjs.org/)
- **Storage**: Browser IndexedDB (client-side, no server)
- **APIs**:
  - [GitHub Gist API](https://docs.github.com/en/rest/gists) — route sharing (free; sharer needs a PAT with `gist` scope)
  - [Open-Meteo](https://open-meteo.com/) — weather (free, no key)
  - [Nominatim](https://nominatim.org/) — reverse geocoding (free)

## File Structure

```
web-gpx-library/
├── index.html              # Main HTML shell
├── style.css               # All styles
├── js/
│   ├── app.js              # Core app logic
│   ├── storage.js          # IndexedDB wrapper
│   ├── gpxParser.js        # GPX parsing & stats
│   ├── mapManager.js       # Leaflet integration
│   ├── view3d.js           # MapLibre GL 3D terrain view
│   ├── activities.js       # Activity catalogue
│   └── editor.js           # Route editor modal
└── README.md               # This file
```

## Installation & Development

### Local Setup
```bash
# Clone the repo
git clone https://github.com/yourusername/web-gpx-library.git
cd web-gpx-library

# Serve locally (any HTTP server works)
python3 -m http.server 8000
# or
npx http-server
```

Then open `http://localhost:8000` in your browser.

### Deploy to GitHub Pages
1. Push to your GitHub repo
2. Go to **Settings** → **Pages**
3. Select **Deploy from a branch** → `main` branch
4. Save — your site is live at `https://yourusername.github.io/web-gpx-library`

## Data & Privacy

- **All data stays in your browser.** No server, no tracking, no cloud sync.
- IndexedDB is local to your device and browser.
- Export your library regularly for backup.
- Clearing browser site data will delete your library (export first!).

## Browser Support

- Chrome 24+
- Firefox 16+
- Safari 10+
- Edge 15+

(Requires IndexedDB and WebGL support — all modern browsers)

## Features Breakdown

### Difficulty Rating Algorithm
Routes are scored based on:
- **Distance** (base points per km)
- **Total gain** (accumulated uphill elevation, adjusted by gradient)
- **Gradient** (steeper = harder; computed as elevation range ÷ total distance)
- Category-specific thresholds (cycling is "easier" than mountaineering at equal distance)

Levels: 🟢 Easy, 🟡 Moderate, 🔴 Hard, ⚫ Expert

### Activity Types (25+)
**Hiking & Walking**: Hike, Trail Walking, Ultralight Hiking, Fell Running  
**Mountain Sports**: Mountaineering, Rock Climbing, Via Ferrata, Alpine Skiing, Ski Mountaineering  
**Cycling**: Road Bike, Gravel Bike, Cycling, Trail Cycling, MTB, E-MTB, Enduro, Downhill, Bikepacking  
**Snow**: Touring Ski, Backcountry Skiing, Snowshoeing  
**Running**: Running, Trail Running  
**Water Sports**: Kayaking, Packrafting  

### Elevation Profile
- Visual representation of elevation vs. distance
- Hover to see exact elevation and gradient at any point
- Gradient per segment shown as an arrow: ↑ uphill, → flat, ↓ downhill

### Unit Toggle
Switch between **metric** (km, m, km/h) and **imperial** (mi, ft, mph) on the fly.

## Keyboard Shortcuts

- **Escape** — close editor modal or exit 3D terrain view
- **Double-click split handle** — auto-fit map and details panel
- **Drag split handle** — manually resize map vs. details

## Contributing

Found a bug or have a feature request? Open an issue on GitHub!

---

**Built with ❤️ for outdoor enthusiasts** — enjoy mapping your adventures! 🏔️🚴🏃

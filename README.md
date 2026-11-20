# Smart Park — Parking Prediction & Booking (Shimla)

Smart Park predicts which parking lot will actually have a free slot when you arrive,
ranks the best options for your trip, draws the route, and lets residents rent out
their own empty parking space.

The prediction and routing core is written in **C++** (graphs, heaps, hash maps);
the browser is a plain black-and-white web UI. The page never computes a prediction —
it calls the compiled C++ engine through a small Node bridge.

```
ISBT Tutikandi ──▶ "park near Chhota Shimla" ──▶ ranked lots + route + predicted free slots
```

---

## Features

- **Future availability, not just "now"** — pick an arrival offset (now, +10, +20, +30, +45, +60 min) and see how many slots each lot is predicted to have at that moment.
- **Best-parking ranking** — a weighted score over predicted vacancy, drive time, walking distance to your destination, price and convenience (covered / CCTV / guard / EV).
- **Multiple options per area** — stacked lot markers tot up the predicted free slots for a locality; click one to open a card comparing every lot there (price, capacity, walk, score) and pick one.
- **Route with traffic** — Dijkstra over the Shimla road graph, using time-of-day congestion factors; walking time to the destination comes from the same graph.
- **Availability timeline** — a bar chart of predicted free slots for the next 60 minutes per lot.
- **Confidence** — every prediction reports how reliable it is (falls when a lot is nearly empty or nearly full).
- **List your own space** — apartment stilt, shop front, courtyard: owner, phone, locality, slots, ₹/hour, open hours, allowed vehicles, convenience flags and notes. Published spaces appear on the map instantly and are bookable by other users.
- **Bookings** — booking a slot immediately reduces the availability everyone else sees.
- **Time-of-day simulator** — drag a slider to watch morning / evening peaks change both traffic and availability.

---

## Screens (tabs)

| Tab | What it does |
| --- | --- |
| **Predict** | Journey form, map with numbered lots, ranked results, route, booking |
| **List your space** | Publish a private parking space and manage your listings |
| **My bookings** | Active bookings, cancellation codes, slot ledger |
| **Engine & data structures** | How the model works + live JSON from the C++ engine |

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Prediction / routing core | C++17 (STL only) |
| Bridge server | Node.js, no external dependencies |
| Frontend | Plain HTML + CSS + ES modules (no framework, no build step) |
| Map | Hand-built SVG from the engine's own coordinates |

No API keys, no database, no internet services — everything runs locally.

---

## Project structure

```
smart-park/
├── engine/
│   └── engine.cpp        # C++: graph, min-heap, Dijkstra, occupancy model
├── server/
│   └── server.js         # static files + /api/meta + /api/predict → runs the binary
├── public/
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── app.js        # UI state, prediction calls, booking, space listing
│       └── map.js        # SVG map rendering + route overlay
├── package.json
└── README.md
```

---

## Run it

Requirements: **g++ (C++17)** and **Node.js 18+**.

```bash
# 1. build the C++ engine (optional — the server builds it automatically)
npm run build:engine

# 2. start the server
npm start
```

Open **http://localhost:3000**.

Manual compile if you prefer:

```bash
g++ -O2 -std=c++17 engine/engine.cpp -o engine/engine
./engine/engine <<< $'Q|isbt|chhotashimla|4W|18|20'
```

The server rebuilds `engine/engine` whenever `engine.cpp` is newer than the binary.

---

## How the prediction works

### 1. Demand and traffic curves

Two Gaussian-with-peaks curves over the hour of day (0–23):

- **demand** — peaks around 10:30 and 18:00 (shopping / office / school runs)
- **traffic** — peaks around 09:30 and 18:20, used for both drive times and arrival pressure

### 2. Lot occupancy

```
occupancy(lot, hour) = clamp(0.10 + 0.80 × popularity × demand(hour), 0.02, 0.97)
free now             = capacity − round(capacity × occupancy) − slots you booked
```

### 3. Prediction at t + offset

```
arrivals/min   = capacity × 0.0052 × popularity × demand × (0.70 + 0.60 × traffic)
departures/min = occupied × 0.0098            # average stay ≈ 100 minutes
predicted free = clamp(free now − (arrivals − departures) × offset, 0, capacity)
confidence     = 0.63 + 0.32 × (1 − |2 × freeRatio − 1|)
```

Confidence is highest when the lot is comfortably half-full and lowest at the extremes.

### 4. Ranking score

```
score = 0.32 × predicted vacancy
      + 0.26 × (1 − drive_time / 45 min)
      + 0.17 × (1 − walk_distance / 18 min)
      + 0.12 × (1 − price / ₹40)
      + 0.13 × convenience (covered, CCTV, guard, EV)
```

A lot predicted to be full is **not hidden** — its score is cut by 40% and it is shown
as an alternative, so the driver still sees the risk. The top 6 lots fill the results
panel; the full ranking is returned too, so the map can show every option in an area.

---

## Data structures (C++)

| Structure | Where it is used |
| --- | --- |
| **Min-heap** (generic template `MinHeap<T, Cmp>` with sift-up / sift-down) | Dijkstra's frontier — always expands the nearest stop |
| **Weighted graph as adjacency list** `unordered_map<string, vector<Edge>>` | 13 localities (nodes) + 18 road segments (edges with km, road name, congestion factor) |
| **Hash maps** | node table, zone table, booked-slot counters |
| **Vectors** | per-lot availability timeline (+0 … +60 min), sorted result list |
| **`stable_sort`** | final ranking by score, keeping ties in insertion order |
| **Path reconstruction via `prev[]`** | rebuilds the route stack after Dijkstra terminates |

Dijkstra is run twice per candidate lot on the **same graph**:

- **drive mode** — minimises travel time (`km / speed(hour, road)`)
- **walk mode** — minimises distance at 4.5 km/h

That is how the app knows both "9 minutes by car" and "13 minutes on foot".

---

## Engine protocol (stdin → JSON)

The bridge writes commands to the C++ binary and reads one JSON object back.
This makes the core easy to test from a terminal.

```
META
Q|originNode|destNode|vehicle|hour|offsetMinutes
S|id|node|name|capacity|price|2W,4W|covered|cctv|guard|ev|popularity|owner
B|zoneId|count
```

Example:

```bash
printf 'Q|isbt|chhotashimla|SUV|18|20\nS|u-1|chhotashimla|My stilt|6|15|2W,4W,SUV|1|1|0|0|0.85|Owner\nB|u-1|1\n' \
  | ./engine/engine
```

Returns origin/destination, traffic state, and a ranked `results[]` array where each
entry carries predicted slots, timeline, confidence, score, drive stats, walk time and
the full route (`stops[]`, `roads[]`).

---

## Dataset

22 parking options across 13 Shimla localities, each with capacity, hourly price,
vehicle types and convenience features. Busier areas carry two competing lots, so the
map can be opened to compare them side by side:

| Locality | Option | Slots | ₹/hr |
| --- | --- | --- | --- |
| ISBT Tutikandi | Multi-level | 60 | 20 |
| ISBT Tutikandi | Open yard | 34 | 10 |
| Annadale | Ground parking | 50 | 20 |
| Annadale | Green ground | 26 | 12 |
| Sanjauli | Bazaar lot | 40 | 15 |
| Sanjauli | Two-wheeler stand | 60 | 5 |
| Kasumpti | Bus stand lot | 35 | 15 |
| Kasumpti | Open ground | 18 | 8 |
| Chhota Shimla | Market bay | 30 | 20 |
| Chhota Shimla | Stilt parking | 12 | 10 |
| Dhalli | Bypass truck bay | 28 | 10 |
| Dhalli | Bus stop bay | 14 | 8 |
| Panthaghati | Roadside bay | 25 | 10 |
| Khalini | Office complex | 24 | 15 |
| Khalini | Two-wheeler stand | 16 | 5 |
| Summer Hill | Rail lot | 22 | 15 |
| Summer Hill | Cart Road bay | 9 | 10 |
| Boileauganj | Street lot | 20 | 25 |
| Vikasnagar | Community lot | 18 | 10 |
| Jutogh | Cantt lot | 15 | 10 |
| New Shimla | Sector-3 bay | 45 | 10 |
| New Shimla | Sector-2 bay | 20 | 10 |

**Ridge, Mall Road and Lakkar Bazar are deliberately excluded** — they are
pedestrian-only areas with no private or public car parking. Locality coordinates and
road connections are approximations for the graph, not survey data.

---

## Notes / limitations

- Occupancy is a **model**, not live sensor data: no real-time feed is wired in, so numbers are simulated deterministically from the demand curve.
- Bookings and listed spaces are stored in the browser's `localStorage` — there is no user account or server-side database.
- The map is a schematic SVG built from the engine's coordinates, not a tile map.
- A natural next step would be replacing the demand curve with a real occupancy feed (or a booking-history dataset) and swapping the SVG for a tile map.

---

## Academic context

Built as a second-year data-structures project: the emphasis is on implementing a
graph, a heap-based priority queue, hash maps and sorting from scratch in C++ and using
them for a real problem — predicting and choosing parking in a hill city.

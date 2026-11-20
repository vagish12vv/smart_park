// ============================================================
//  SMART PARK  —  Shimla parking prediction engine
//  Data-structure core (C++17)
//    * weighted graph  : adjacency list (unordered_map<string, vector<Edge>>)
//    * min-heap        : template class used by Dijkstra + top-K ranking
//    * hash maps       : nodes, zones, booked counters
//    * vectors / arrays: per-zone 5-step availability timeline
//  Protocol: reads commands on stdin, prints one JSON object.
//    META
//    Q|originNode|destNode|vehicle|hour|offsetMinutes
//    S|id|node|name|capacity|price|2W,4W|covered|cctv|guard|ev|popularity|owner
//    B|zoneId|count
// ============================================================
#include <bits/stdc++.h>
using namespace std;

static double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
static string jstr(const string& s) {
  string o = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c == '\n') o += "\\n";
    else o += c;
  }
  return o + "\"";
}
static string jnum(double v, int p = 1) {
  ostringstream os; os << fixed << setprecision(p) << v;
  string s = os.str();
  if (p > 0 && s.find('.') != string::npos) {           // trim trailing .0
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  return s;
}
static string jbool(bool b) { return b ? "true" : "false"; }

// ------------------------------------------------------------
//  Graph
// ------------------------------------------------------------
struct Node { string id, name; double lat = 0, lng = 0; };

struct Edge {
  string to;
  double km = 0;
  double busy = 0.3;   // 0..1  how congested this road gets at peak
  string road;
};

struct EdgePair { string a, b, road; double km, busy; };

struct Route {
  bool found = false;
  vector<string> nodes;
  vector<string> roads;
  double km = 0;
  double minutes = 0;
};

struct Zone {
  string id, name, node, owner;
  int capacity = 0;
  double price = 0;
  vector<string> vehicles;
  bool covered = false, cctv = false, guard = false, ev = false;
  bool community = false;
  double popularity = 0.8;
};

// ------------------------------------------------------------
//  Min-heap (generic, comparator based) — the work-horse DS
// ------------------------------------------------------------
template <class T, class Cmp>
class MinHeap {
public:
  bool empty() const { return h.empty(); }
  size_t size() const { return h.size(); }
  void push(const T& v) { h.push_back(v); siftUp((int)h.size() - 1); }
  T pop() {
    T top = h.front();
    h.front() = h.back();
    h.pop_back();
    if (!h.empty()) siftDown(0);
    return top;
  }
private:
  vector<T> h;
  Cmp cmp;
  void siftUp(int i) {
    while (i > 0) {
      int p = (i - 1) / 2;
      if (cmp(h[i], h[p])) { swap(h[i], h[p]); i = p; } else break;
    }
  }
  void siftDown(int i) {
    int n = (int)h.size();
    while (true) {
      int l = 2 * i + 1, r = l + 1, best = i;
      if (l < n && cmp(h[l], h[best])) best = l;
      if (r < n && cmp(h[r], h[best])) best = r;
      if (best == i) break;
      swap(h[i], h[best]);
      i = best;
    }
  }
};

struct QItem { double dist; string node; };
struct QItemMin { bool operator()(const QItem& a, const QItem& b) const { return a.dist > b.dist; } };

// ------------------------------------------------------------
//  Engine
// ------------------------------------------------------------
class ParkingEngine {
public:
  unordered_map<string, Node> nodes;
  unordered_map<string, vector<Edge>> adj;
  unordered_map<string, Zone> zones;
  vector<EdgePair> edgeList;

  ParkingEngine() { seed(); }

  // ---------------- demand & traffic curves ----------------
  static double gauss(double x, double c, double s) { return exp(-((x - c) * (x - c)) / (2 * s * s)); }

  // how badly people want parking (0 .. ~1.15)
  static double demandCurve(int h) {
    return clampd(0.08 + 0.95 * gauss(h, 10.5, 2.4) + 0.85 * gauss(h, 18.0, 2.0) + 0.45 * gauss(h, 14.0, 3.0), 0, 1.15);
  }
  // road congestion (0 .. 1)
  static double trafficCurve(int h) {
    return clampd(0.05 + 0.62 * gauss(h, 9.8, 1.7) + 0.95 * gauss(h, 18.3, 1.9) + 0.50 * gauss(h, 13.5, 2.6), 0, 1.0);
  }
  static const char* trafficLabel(double t) {
    if (t < 0.18) return "Free flowing";
    if (t < 0.42) return "Moderate";
    if (t < 0.68) return "Heavy";
    return "Jammed";
  }

  // ---------------- occupancy model ----------------
  static double occupancyRatio(const Zone& z, int h) {
    double d = demandCurve(h);
    double ratio = 0.10 + 0.80 * z.popularity * d;
    return clampd(ratio, 0.02, 0.97);
  }
  static int freeNow(const Zone& z, int h, int booked) {
    int occ = (int)llround(z.capacity * occupancyRatio(z, h)) + booked;
    return (int)clampd(z.capacity - occ, 0, z.capacity);
  }
  static int predictFree(const Zone& z, int h, int offset, int booked) {
    int f0 = freeNow(z, h, booked);
    int occupied = z.capacity - f0;
    double d = demandCurve(h), tf = trafficCurve(h);
    // arrivals per minute into this lot
    double arrivals = z.capacity * 0.0052 * z.popularity * d * (0.70 + 0.60 * tf);
    // departures per minute (average stay ~ 100 min)
    double departures = occupied * 0.0098;
    double net = (arrivals - departures) * offset;
    return (int)clampd(llround(f0 - net), 0, z.capacity);
  }
  static double confidence(int predicted, int capacity) {
    double r = (double)predicted / max(1, capacity);
    return clampd(0.63 + 0.32 * (1.0 - fabs(2 * r - 1)), 0.60, 0.95);
  }

  // ---------------- graph helpers ----------------
  void addNode(const string& id, const string& name, double lat, double lng) {
    nodes[id] = Node{id, name, lat, lng};
    adj[id];
  }
  void addEdge(const string& a, const string& b, double km, double busy, const string& road) {
    adj[a].push_back(Edge{b, km, busy, road});
    adj[b].push_back(Edge{a, km, busy, road});
    edgeList.push_back(EdgePair{a, b, road, km, busy});
  }
  double edgeMinutes(const Edge& e, int h) const {
    double tf = trafficCurve(h);
    double speed = 24.0 * (1.0 - 0.55 * tf * (0.75 + 0.5 * e.busy));  // km/h, hill roads
    speed = max(7.0, speed);
    return (e.km / speed) * 60.0;
  }
  const Edge* findEdge(const string& a, const string& b) const {
    auto it = adj.find(a);
    if (it == adj.end()) return nullptr;
    for (const Edge& e : it->second) if (e.to == b) return &e;
    return nullptr;
  }
  // extra length added at heavy-hours to make routes prefer lighter roads
  double weight(const Edge& e, int h) const {
    double tf = trafficCurve(h);
    return e.km * (1.0 + 1.35 * tf * e.busy);
  }

  // ---------------- Dijkstra (min-heap) ----------------
  // mode 0 = driving (weighted by travel time), 1 = walking (weighted by km)
  Route dijkstra(const string& src, const string& dst, int mode, int h) const {
    Route r;
    if (!adj.count(src) || !adj.count(dst)) return r;
    if (src == dst) { r.found = true; r.nodes = {src}; return r; }

    unordered_map<string, double> dist;
    unordered_map<string, string> prev, prevRoad;
    MinHeap<QItem, QItemMin> pq;
    dist[src] = 0;
    pq.push(QItem{0, src});

    while (!pq.empty()) {
      QItem cur = pq.pop();
      auto itd = dist.find(cur.node);
      if (itd == dist.end() || cur.dist > itd->second + 1e-9) continue;  // stale entry
      if (cur.node == dst) break;
      for (const Edge& e : adj.at(cur.node)) {
        double w = (mode == 0) ? edgeMinutes(e, h) : e.km;
        double nd = cur.dist + w;
        auto it = dist.find(e.to);
        if (it == dist.end() || nd < it->second - 1e-9) {
          dist[e.to] = nd;
          prev[e.to] = cur.node;
          prevRoad[e.to] = e.road;
          pq.push(QItem{nd, e.to});
        }
      }
    }
    if (!dist.count(dst)) return r;

    // rebuild path (backtracking over prev[])
    vector<string> rev;
    for (string at = dst;; at = prev[at]) {
      rev.push_back(at);
      if (at == src) break;
    }
    reverse(rev.begin(), rev.end());

    r.found = true;
    r.nodes = rev;
    for (size_t i = 1; i < rev.size(); i++) {
      r.roads.push_back(prevRoad[rev[i]]);
      if (const Edge* e = findEdge(rev[i - 1], rev[i])) {
        r.km += e->km;
        r.minutes += (mode == 0) ? edgeMinutes(*e, h) : (e->km / 4.5) * 60.0;
      }
    }
    return r;
  }

  // ---------------- results ----------------
  struct Result {
    Zone z;
    double score = 0, conf = 0, km = 0, etaMin = 0, walkMin = 0;
    int predicted = 0, fNow = 0;
    vector<pair<int, int>> timeline;   // {minutesFromNow, freeSlots}
    Route drive;
  };

  bool supports(const Zone& z, const string& v) const {
    for (const string& x : z.vehicles) if (x == v) return true;
    return false;
  }

  vector<Result> rank(const string& origin, const string& dest, const string& vehicle,
                      int hour, int offset, const unordered_map<string, int>& booked) const {
    vector<Result> out;
    for (const auto& kv : zones) {
      const Zone& z = kv.second;
      if (!supports(z, vehicle)) continue;
      int bk = 0;
      auto bit = booked.find(z.id);
      if (bit != booked.end()) bk = bit->second;

      Result r;
      r.z = z;
      r.fNow = freeNow(z, hour, bk);
      r.predicted = predictFree(z, hour, offset, bk);
      r.conf = confidence(r.predicted, z.capacity);
      r.drive = dijkstra(origin, z.node, 0, hour);
      if (!r.drive.found) continue;
      Route walk = dijkstra(z.node, dest, 1, hour);
      r.walkMin = walk.found ? walk.minutes : 0;
      r.km = r.drive.km;
      r.etaMin = r.drive.minutes;

      for (int m = 0; m <= 60; m += 15)
        r.timeline.push_back({m, predictFree(z, hour, m, bk)});

      double freeRatio = (double)r.predicted / max(1, z.capacity);
      double etaScore = 1.0 - clampd(r.etaMin / 45.0, 0, 1);
      double priceScore = 1.0 - clampd(z.price / 40.0, 0, 1);
      double walkScore = 1.0 - clampd(r.walkMin / 18.0, 0, 1);
      double comfort = ((z.covered ? 1 : 0) + (z.cctv ? 1 : 0) + (z.guard ? 1 : 0) + (z.ev ? 1 : 0)) / 4.0;
      double s = 100 * (0.32 * freeRatio + 0.26 * etaScore + 0.12 * priceScore + 0.17 * walkScore + 0.13 * comfort);
      if (r.predicted < 1) s *= 0.60;                            // almost full penalty
      r.score = round(s * 10) / 10.0;
      out.push_back(r);
    }
    // full ranking: best first, ties keep insertion order
    stable_sort(out.begin(), out.end(), [](const Result& a, const Result& b) { return a.score > b.score; });
    return out;
  }

  // ---------------- seed dataset ----------------
  void seed() {
    addNode("isbt",        "ISBT Tutikandi",      31.1072, 77.1592);
    addNode("boileauganj", "Boileauganj",         31.1078, 77.1530);
    addNode("summerhill",  "Summer Hill",         31.1113, 77.1440);
    addNode("vikasnagar",  "Vikasnagar",          31.1030, 77.1437);
    addNode("newshimla",   "New Shimla",          31.0960, 77.1420);
    addNode("panthaghati", "Panthaghati",         31.0905, 77.1472);
    addNode("kasumpti",    "Kasumpti",            31.0926, 77.1578);
    addNode("chhotashimla","Chhota Shimla",       31.0975, 77.1613);
    addNode("khalini",     "Khalini",             31.1008, 77.1636);
    addNode("sanjauli",    "Sanjauli",            31.1040, 77.1930);
    addNode("annadale",    "Annadale",            31.1073, 77.1660);
    addNode("dhalli",      "Dhalli",              31.0895, 77.1245);
    addNode("jutogh",      "Jutogh",              31.0957, 77.1268);

    addEdge("isbt", "annadale",     1.3, 0.70, "Annadale – Tutikandi Road");
    addEdge("isbt", "boileauganj",  1.2, 0.60, "Tutikandi – Boileauganj Road");
    addEdge("boileauganj", "summerhill", 1.4, 0.50, "Cart Road Service Road");
    addEdge("summerhill", "vikasnagar",  1.1, 0.40, "Summer Hill Road");
    addEdge("vikasnagar", "newshimla",   1.5, 0.30, "New Shimla Link Road");
    addEdge("newshimla", "panthaghati",  1.3, 0.30, "New Shimla – Panthaghati Road");
    addEdge("panthaghati", "kasumpti",   1.6, 0.40, "Panthaghati – Kasumpti Road");
    addEdge("kasumpti", "chhotashimla",  1.1, 0.80, "Kasumpti – Chhota Shimla Road");
    addEdge("chhotashimla", "khalini",   1.0, 0.60, "Chhota Shimla – Khalini Road");
    addEdge("chhotashimla", "annadale",  1.5, 0.70, "Chhota Shimla – Annadale Road");
    addEdge("khalini", "isbt",           1.6, 0.50, "Khalini – Tutikandi Road");
    addEdge("khalini", "sanjauli",       2.6, 0.50, "Chhota Shimla Bypass");
    addEdge("sanjauli", "annadale",      3.0, 0.60, "North Bypass");
    addEdge("boileauganj", "sanjauli",   3.4, 0.55, "Boileauganj – Sanjauli Road");
    addEdge("vikasnagar", "dhalli",      2.2, 0.30, "Dhalli Road");
    addEdge("dhalli", "jutogh",          1.0, 0.20, "Dhalli – Jutogh Road");
    addEdge("jutogh", "newshimla",       2.3, 0.30, "Jutogh – New Shimla Road");
    addEdge("kasumpti", "newshimla",     1.9, 0.35, "Kasumpti – New Shimla Road");

    addZone(Zone{"isbt-ml", "ISBT Tutikandi Multi-Level", "isbt", "", 60, 20,
                 {"4W", "SUV"}, true, true, true, true, false, 0.95});
    addZone(Zone{"annadale", "Annadale Ground Parking", "annadale", "", 50, 20,
                 {"2W", "4W", "SUV"}, false, true, true, false, false, 0.80});
    addZone(Zone{"boileauganj", "Boileauganj Street Lot", "boileauganj", "", 20, 25,
                 {"2W", "4W", "SUV"}, false, false, true, false, false, 1.00});
    addZone(Zone{"summerhill", "Summer Hill Rail Lot", "summerhill", "", 22, 15,
                 {"2W", "4W", "SUV"}, false, true, false, false, false, 0.85});
    addZone(Zone{"vikasnagar", "Vikasnagar Community Lot", "vikasnagar", "", 18, 10,
                 {"2W", "4W", "SUV"}, false, false, false, false, false, 0.70});
    addZone(Zone{"newshimla", "New Shimla Sector-3 Bay", "newshimla", "", 45, 10,
                 {"2W", "4W", "SUV"}, false, true, true, true, false, 0.90});
    addZone(Zone{"panthaghati", "Panthaghati Roadside Bay", "panthaghati", "", 25, 10,
                 {"2W", "4W", "SUV"}, false, false, false, false, false, 0.75});
    addZone(Zone{"kasumpti", "Kasumpti Bus Stand Lot", "kasumpti", "", 35, 15,
                 {"2W", "4W", "SUV"}, true, true, true, false, false, 0.95});
    addZone(Zone{"chhota", "Chhota Shimla Market Bay", "chhotashimla", "", 30, 20,
                 {"2W", "4W"}, false, true, true, false, false, 1.25});
    addZone(Zone{"khalini", "Khalini Office Complex", "khalini", "", 24, 15,
                 {"2W", "4W", "SUV"}, true, true, true, true, false, 1.05});
    addZone(Zone{"sanjauli", "Sanjauli Bazaar Lot", "sanjauli", "", 40, 15,
                 {"2W", "4W", "SUV"}, false, false, true, false, false, 1.20});
    addZone(Zone{"dhalli", "Dhalli Bypass Truck Bay", "dhalli", "", 28, 10,
                 {"4W", "SUV"}, false, false, false, false, false, 0.65});
    addZone(Zone{"jutogh", "Jutogh Cantt Lot", "jutogh", "", 15, 10,
                 {"2W", "4W", "SUV"}, false, false, false, false, false, 0.50});

    // ---- second and third options in the busier localities ----
    addZone(Zone{"isbt-open", "ISBT Tutikandi Open Yard", "isbt", "", 34, 10,
                 {"2W", "4W", "SUV"}, false, false, true, false, false, 0.85});
    addZone(Zone{"annadale-green", "Annadale Green Ground", "annadale", "", 26, 12,
                 {"2W", "4W", "SUV"}, false, false, false, false, false, 0.70});
    addZone(Zone{"summerhill-bay", "Summer Hill Cart Road Bay", "summerhill", "", 9, 10,
                 {"2W", "4W"}, false, false, false, false, false, 0.75});
    addZone(Zone{"newshimla-bay", "New Shimla Sector-2 Bay", "newshimla", "", 20, 10,
                 {"4W", "SUV"}, false, false, true, false, false, 0.80});
    addZone(Zone{"kasumpti-open", "Kasumpti Open Ground", "kasumpti", "", 18, 8,
                 {"2W", "4W", "SUV"}, false, false, false, false, false, 0.75});
    addZone(Zone{"chhota-stilt", "Chhota Shimla Stilt Parking", "chhotashimla", "", 12, 10,
                 {"4W"}, true, true, false, false, false, 0.85});
    addZone(Zone{"khalini-2w", "Khalini Two-Wheeler Stand", "khalini", "", 16, 5,
                 {"2W"}, false, false, true, false, false, 1.00});
    addZone(Zone{"sanjauli-2w", "Sanjauli Two-Wheeler Stand", "sanjauli", "", 60, 5,
                 {"2W"}, false, false, true, false, false, 1.10});
    addZone(Zone{"dhalli-bus", "Dhalli Bus Stop Bay", "dhalli", "", 14, 8,
                 {"2W", "4W"}, false, false, false, false, false, 0.80});
  }

  void addZone(const Zone& z) { zones[z.id] = z; }
};

// ------------------------------------------------------------
//  JSON output
// ------------------------------------------------------------
static void emitMeta(const ParkingEngine& eng) {
  ostringstream o;
  o << "{";
  o << "\"nodes\":[";
  bool first = true;
  for (const auto& kv : eng.nodes) {
    const Node& n = kv.second;
    if (!first) o << ",";
    first = false;
    o << "{\"id\":" << jstr(n.id) << ",\"name\":" << jstr(n.name)
      << ",\"lat\":" << jnum(n.lat, 6) << ",\"lng\":" << jnum(n.lng, 6) << "}";
  }
  o << "],\"edges\":[";
  for (size_t i = 0; i < eng.edgeList.size(); i++) {
    const EdgePair& e = eng.edgeList[i];
    if (i) o << ",";
    o << "{\"a\":" << jstr(e.a) << ",\"b\":" << jstr(e.b)
      << ",\"km\":" << jnum(e.km, 1) << ",\"busy\":" << jnum(e.busy, 2)
      << ",\"road\":" << jstr(e.road) << "}";
  }
  o << "],\"zones\":[";
  first = true;
  for (const auto& kv : eng.zones) {
    const Zone& z = kv.second;
    if (!first) o << ",";
    first = false;
    o << "{\"id\":" << jstr(z.id) << ",\"name\":" << jstr(z.name)
      << ",\"node\":" << jstr(z.node) << ",\"capacity\":" << z.capacity
      << ",\"price\":" << jnum(z.price, 0) << ",\"vehicles\":[";
    for (size_t i = 0; i < z.vehicles.size(); i++) {
      if (i) o << ",";
      o << jstr(z.vehicles[i]);
    }
    o << "],\"covered\":" << jbool(z.covered) << ",\"cctv\":" << jbool(z.cctv)
      << ",\"guard\":" << jbool(z.guard) << ",\"ev\":" << jbool(z.ev)
      << ",\"community\":" << jbool(z.community) << ",\"owner\":" << jstr(z.owner) << "}";
  }
  o << "]}\n";
  cout << o.str();
}

static void emitResult(const ParkingEngine& eng, const string& origin, const string& dest,
                       const string& vehicle, int hour, int offset,
                       const unordered_map<string, int>& booked) {
  vector<ParkingEngine::Result> res = eng.rank(origin, dest, vehicle, hour, offset, booked);
  double tf = ParkingEngine::trafficCurve(hour);

  auto nodeJson = [&](const string& id) {
    auto it = eng.nodes.find(id);
    if (it == eng.nodes.end()) return string("{\"id\":\"\",\"name\":\"\",\"lat\":0,\"lng\":0}");
    ostringstream s;
    s << "{\"id\":" << jstr(it->second.id) << ",\"name\":" << jstr(it->second.name)
      << ",\"lat\":" << jnum(it->second.lat, 6) << ",\"lng\":" << jnum(it->second.lng, 6) << "}";
    return s.str();
  };

  ostringstream o;
  o << "{";
  o << "\"origin\":" << nodeJson(origin) << ",";
  o << "\"destination\":" << nodeJson(dest) << ",";
  o << "\"vehicle\":" << jstr(vehicle) << ",";
  o << "\"hour\":" << hour << ",\"offset\":" << offset << ",";
  o << "\"traffic\":{\"factor\":" << jnum(tf, 2)
    << ",\"label\":" << jstr(ParkingEngine::trafficLabel(tf)) << "},";
  // one lot object: the ranked card and the map both read from this shape
  auto lotJson = [&](const ParkingEngine::Result& r) {
    ostringstream s;
    s << "{\"id\":" << jstr(r.z.id) << ",\"name\":" << jstr(r.z.name)
      << ",\"node\":" << jstr(r.z.node) << ",\"capacity\":" << r.z.capacity
      << ",\"price\":" << jnum(r.z.price, 0) << ",\"vehicles\":[";
    for (size_t v = 0; v < r.z.vehicles.size(); v++) {
      if (v) s << ",";
      s << jstr(r.z.vehicles[v]);
    }
    s << "],\"covered\":" << jbool(r.z.covered) << ",\"cctv\":" << jbool(r.z.cctv)
      << ",\"guard\":" << jbool(r.z.guard) << ",\"ev\":" << jbool(r.z.ev)
      << ",\"community\":" << jbool(r.z.community) << ",\"owner\":" << jstr(r.z.owner)
      << ",\"predicted\":" << r.predicted << ",\"freeNow\":" << r.fNow
      << ",\"score\":" << jnum(r.score, 1)
      << ",\"confidence\":" << jnum(r.conf * 100, 0)
      << ",\"etaMin\":" << jnum(r.etaMin, 0) << ",\"km\":" << jnum(r.km, 1)
      << ",\"walkMin\":" << jnum(r.walkMin, 0) << ",\"timeline\":[";
    for (size_t t = 0; t < r.timeline.size(); t++) {
      if (t) s << ",";
      s << "{\"min\":" << r.timeline[t].first << ",\"free\":" << r.timeline[t].second << "}";
    }
    s << "],\"route\":{\"stops\":[";
    for (size_t n = 0; n < r.drive.nodes.size(); n++) {
      if (n) s << ",";
      s << nodeJson(r.drive.nodes[n]);
    }
    s << "],\"roads\":[";
    for (size_t n = 0; n < r.drive.roads.size(); n++) {
      if (n) s << ",";
      s << jstr(r.drive.roads[n]);
    }
    s << "],\"km\":" << jnum(r.drive.km, 1) << ",\"minutes\":" << jnum(r.drive.minutes, 0) << "}}";
    return s.str();
  };

  size_t top = min<size_t>(6, res.size());
  o << "\"results\":[";
  for (size_t i = 0; i < top; i++) {
    if (i) o << ",";
    o << lotJson(res[i]);
  }
  o << "],\"all\":[";
  for (size_t i = 0; i < res.size(); i++) {
    if (i) o << ",";
    o << lotJson(res[i]);
  }
  o << "]}\n";
  cout << o.str();
}

// ------------------------------------------------------------
//  stdin parser
// ------------------------------------------------------------
static vector<string> split(const string& s, char d) {
  vector<string> out;
  string cur;
  for (char c : s) {
    if (c == d) { out.push_back(cur); cur.clear(); }
    else cur += c;
  }
  out.push_back(cur);
  return out;
}
static string trim(string s) {
  while (!s.empty() && (s.back() == '\r' || s.back() == '\n' || s.back() == ' ')) s.pop_back();
  while (!s.empty() && s.front() == ' ') s.erase(s.begin());
  return s;
}

int main() {
  ios::sync_with_stdio(false);
  ParkingEngine eng;

  string line;
  vector<string> query;
  vector<Zone> userZones;
  unordered_map<string, int> booked;

  while (getline(cin, line)) {
    line = trim(line);
    if (line.empty()) continue;
    vector<string> f = split(line, '|');
    if (f[0] == "META") { emitMeta(eng); return 0; }
    if (f[0] == "Q" && f.size() >= 6) query = f;
    if (f[0] == "S" && f.size() >= 13) {
      Zone z;
      z.id = f[1]; z.node = f[2]; z.name = f[3];
      z.capacity = max(1, atoi(f[4].c_str()));
      z.price = atof(f[5].c_str());
      if (!f[6].empty()) z.vehicles = split(f[6], ',');
      z.covered = f[7] == "1"; z.cctv = f[8] == "1";
      z.guard = f[9] == "1"; z.ev = f[10] == "1";
      z.popularity = clampd(atof(f[11].c_str()), 0.3, 1.4);
      z.owner = (f.size() > 12) ? f[12] : "";
      z.community = true;
      userZones.push_back(z);
    }
    if (f[0] == "B" && f.size() >= 3) booked[f[1]] = atoi(f[2].c_str());
  }
  for (const Zone& z : userZones) eng.addZone(z);

  if (query.size() >= 6) {
    string origin = query[1], dest = query[2], vehicle = query[3];
    int hour = atoi(query[4].c_str());
    int offset = atoi(query[5].c_str());
    if (!eng.nodes.count(origin)) origin = "isbt";
    if (!eng.nodes.count(dest)) dest = "chhotashimla";
    emitResult(eng, origin, dest, vehicle, max(0, min(23, hour)), max(0, min(120, offset)), booked);
  } else {
    emitMeta(eng);
  }
  return 0;
}

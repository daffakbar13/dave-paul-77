//+------------------------------------------------------------------+
//| DavePaul77Exec.mq5                                               |
//| Executor for DavePaul77: reports balance and symbol specs, takes |
//| the command of the logged-in account, deletes the app's pending  |
//| orders (magic number) and places the new buy/sell stops.         |
//| Open positions and manual orders are never touched.              |
//|                                                                  |
//| DryRun is ON by default: it only logs what it would do and       |
//| reports that to the web. Turn it off only on a tested account.   |
//|                                                                  |
//| Setup: Tools > Options > Expert Advisors > Allow WebRequest for  |
//| the server URL, Algo Trading on. Attach to ONE chart.            |
//| ServerUrl / AccountKey left empty are read from                  |
//| MQL5/Files/DavePaul77.ini:                                       |
//|   ServerUrl=https://...                                          |
//|   Key.<login>=<key from the web>   (one line per MT5 account)    |
//| so switching accounts in this terminal needs no input changes.   |
//+------------------------------------------------------------------+
#property copyright "DavePaul77"
#property version   "1.00"

#include <Trade/Trade.mqh>

input string ServerUrl     = "";     // URL server (kosong = dari DavePaul77.ini)
input string AccountKey    = "";     // Key akun (kosong = Key.<login> dari DavePaul77.ini)
input bool   DryRun        = true;   // Dry-run: hanya mencatat, tidak memasang order
input long   MagicNumber   = 77077;  // Magic number order aplikasi
input int    PollSeconds   = 5;      // jeda ambil perintah
input int    StatusSeconds = 60;     // jeda lapor balance dan spesifikasi simbol
input int    TimeoutMs     = 30000;  // Render gratis bisa butuh 30-50 detik untuk bangun

CTrade   g_trade;
string   g_url = "";
string   g_key = "";
long     g_login = 0;
datetime g_lastStatus = 0;
bool     g_warnedConfig = false;
bool     g_warnedTrade = false;
string   g_unsentPath = "";  // result that could not be delivered; retried before new work
string   g_unsentBody = "";

//+------------------------------------------------------------------+
//| Config: inputs win over the ini file                             |
//+------------------------------------------------------------------+
void LoadConfig(const long login)
  {
   g_url = ServerUrl;
   g_key = AccountKey;
   int h = FileOpen("DavePaul77.ini", FILE_READ | FILE_TXT | FILE_ANSI);
   if(h != INVALID_HANDLE)
     {
      string keyName = "Key." + IntegerToString(login);
      while(!FileIsEnding(h))
        {
         string line = FileReadString(h);
         StringTrimLeft(line);
         StringTrimRight(line);
         int eq = StringFind(line, "=");
         if(eq <= 0 || StringGetCharacter(line, 0) == '#')
            continue;
         string name = StringSubstr(line, 0, eq);
         string value = StringSubstr(line, eq + 1);
         if(name == "ServerUrl" && StringLen(g_url) == 0)
            g_url = value;
         if(name == keyName && StringLen(g_key) == 0)
            g_key = value;
        }
      FileClose(h);
     }
   if(StringLen(g_url) > 0 && StringGetCharacter(g_url, StringLen(g_url) - 1) == '/')
      g_url = StringSubstr(g_url, 0, StringLen(g_url) - 1);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   g_trade.SetExpertMagicNumber((ulong)MagicNumber);
   EventSetTimer(MathMax(PollSeconds, 1));
   Print("DavePaul77: eksekutor siap, ", DryRun ? "DRY-RUN (tidak memasang order)" : "LIVE", ", magic ", MagicNumber);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTick() {}

void OnTimer()
  {
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   if(login == 0)
      return; // not connected yet
   if(login != g_login)
     {
      g_login = login;
      LoadConfig(login);
      g_lastStatus = 0;
      g_warnedConfig = false;
      g_warnedTrade = false;
      Print("DavePaul77: akun ", login, ", server ", g_url);
     }
   if(StringLen(g_url) == 0 || StringLen(g_key) == 0)
     {
      if(!g_warnedConfig)
         Print("DavePaul77: ServerUrl atau key akun ", login, " belum ada. Isi input EA atau baris Key.", login, "= di MQL5/Files/DavePaul77.ini");
      g_warnedConfig = true;
      return;
     }

   if(StringLen(g_unsentPath) > 0)
     {
      string r;
      int code = Http("POST", g_unsentPath, g_unsentBody, r);
      if(code != 200 && (code < 400 || code >= 500))
         return; // network or server down: try again next timer
      Print("DavePaul77: hasil tertunda ", code == 200 ? "terkirim " : "ditolak server ", r);
      g_unsentPath = "";
      g_unsentBody = "";
     }

   if(TimeLocal() - g_lastStatus >= StatusSeconds)
     {
      if(!SendStatus())
         return;
      g_lastStatus = TimeLocal();
     }

   // a live command must not be taken when this terminal cannot trade: it would be lost
   bool canTrade = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED);
   if(!DryRun && !canTrade)
     {
      if(!g_warnedTrade)
         Print("DavePaul77: Algo Trading mati, perintah tidak diambil sampai dinyalakan");
      g_warnedTrade = true;
      return;
     }
   PollCommand();
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
int Http(const string method, const string path, const string body, string &response)
  {
   char data[];
   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\nX-Api-Key: " + g_key + "\r\nngrok-skip-browser-warning: 1\r\n";
   if(StringLen(body) > 0)
     {
      StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, ArraySize(data) - 1); // drop the terminating zero
     }
   ResetLastError();
   int code = WebRequest(method, g_url + path, headers, TimeoutMs, data, result, resultHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      if(err == 4014)
         Print("DavePaul77: URL belum diizinkan. Tambahkan ", g_url, " di Tools > Options > Expert Advisors > Allow WebRequest");
      else
         Print("DavePaul77: WebRequest gagal, error ", err, " (", path, ")");
      return(-1);
     }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code >= 400)
      Print("DavePaul77: HTTP ", code, " ", path, " ", response);
   return(code);
  }

//+------------------------------------------------------------------+
//| Minimal JSON readers for the flat objects the server sends       |
//+------------------------------------------------------------------+
string JsonString(const string src, const string key)
  {
   string tag = "\"" + key + "\":\"";
   int p = StringFind(src, tag);
   if(p < 0)
      return("");
   p += StringLen(tag);
   int q = StringFind(src, "\"", p);
   return(q < 0 ? "" : StringSubstr(src, p, q - p));
  }

string JsonRaw(const string src, const string key)
  {
   string tag = "\"" + key + "\":";
   int p = StringFind(src, tag);
   if(p < 0)
      return("");
   p += StringLen(tag);
   int q = p;
   int n = StringLen(src);
   while(q < n)
     {
      ushort c = StringGetCharacter(src, q);
      if(c == ',' || c == '}' || c == ']')
         break;
      q++;
     }
   return(StringSubstr(src, p, q - p));
  }

string Num(const double v) { return(DoubleToString(v, 8)); }

string Escape(string s)
  {
   StringReplace(s, "\\", "/");
   StringReplace(s, "\"", "'");
   return(s);
  }

//+------------------------------------------------------------------+
//| Balance and specs of the symbols the server asks for              |
//+------------------------------------------------------------------+
bool SendStatus()
  {
   string response;
   if(Http("GET", "/api/ea/mt5/symbols", "", response) != 200)
      return(false);
   string list[];
   int count = 0;
   int open = StringFind(response, "[");
   int close = StringFind(response, "]", open);
   if(open >= 0 && close > open + 1)
     {
      string inner = StringSubstr(response, open + 1, close - open - 1);
      StringReplace(inner, "\"", "");
      count = StringSplit(inner, ',', list);
     }

   string specs = "";
   for(int i = 0; i < count; i++)
     {
      string s = list[i];
      if(!SymbolSelect(s, true))
        {
         Print("DavePaul77: simbol ", s, " tidak ada di akun ini. Atur mapping simbol akun di web.");
         continue;
        }
      double tickSize = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE);
      double tickValue = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE);
      double point = SymbolInfoDouble(s, SYMBOL_POINT);
      double vmin = SymbolInfoDouble(s, SYMBOL_VOLUME_MIN);
      double vmax = SymbolInfoDouble(s, SYMBOL_VOLUME_MAX);
      double vstep = SymbolInfoDouble(s, SYMBOL_VOLUME_STEP);
      if(tickSize <= 0 || tickValue <= 0 || point <= 0 || vmin <= 0 || vmax <= 0 || vstep <= 0)
         continue; // no quotes yet (market closed or symbol just added): next status
      if(StringLen(specs) > 0)
         specs += ",";
      specs += "\"" + s + "\":{\"digits\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_DIGITS))
               + ",\"point\":" + Num(point)
               + ",\"tickSize\":" + Num(tickSize)
               + ",\"tickValue\":" + Num(tickValue)
               + ",\"volumeMin\":" + Num(vmin)
               + ",\"volumeMax\":" + Num(vmax)
               + ",\"volumeStep\":" + Num(vstep)
               + ",\"stopsLevel\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL)) + "}";
     }
   string body = "{\"account\":" + IntegerToString(g_login)
                 + ",\"balance\":" + Num(AccountInfoDouble(ACCOUNT_BALANCE))
                 + ",\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\""
                 + ",\"symbols\":{" + specs + "}}";
   return(Http("POST", "/api/ea/mt5/status", body, response) == 200);
  }

//+------------------------------------------------------------------+
//| Command: delete the app's pending orders, place the new ones      |
//+------------------------------------------------------------------+
int AppPendings(const bool remove)
  {
   int n = 0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0 || OrderGetInteger(ORDER_MAGIC) != MagicNumber)
         continue;
      ENUM_ORDER_TYPE type = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_STOP && type != ORDER_TYPE_SELL_STOP && type != ORDER_TYPE_BUY_LIMIT && type != ORDER_TYPE_SELL_LIMIT)
         continue;
      if(!remove)
        {
         n++;
         continue;
        }
      if(g_trade.OrderDelete(ticket))
         n++;
      else
         Print("DavePaul77: gagal hapus order #", ticket, ": ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
     }
   return(n);
  }

double NormalizeLot(const string symbol, const double lot)
  {
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      return(lot);
   double v = MathFloor(lot / step + 1e-9) * step; // never round up: risk stays under target
   v = MathMax(vmin, MathMin(vmax, v));
   int decimals = (int)MathMax(0, MathCeil(-MathLog10(step)));
   return(NormalizeDouble(v, decimals));
  }

void PollCommand()
  {
   string response;
   if(Http("GET", "/api/ea/mt5/commands", "", response) != 200)
      return;
   if(StringFind(response, "\"command\":null") >= 0)
      return;
   string id = JsonString(response, "id");
   int start = StringFind(response, "\"orders\":[");
   if(StringLen(id) == 0 || start < 0)
     {
      Print("DavePaul77: format perintah tidak dikenal: ", StringSubstr(response, 0, 200));
      return;
     }
   int end = StringFind(response, "]", start);
   string orders = StringSubstr(response, start + 10, end - start - 10);

   int deleted = AppPendings(!DryRun);
   Print("DavePaul77: perintah ", id, DryRun ? " (DRY-RUN): " : ": ", deleted, " pending order aplikasi ", DryRun ? "akan dihapus" : "dihapus");

   string results = "";
   int placed = 0;
   int failed = 0;
   int pos = 0;
   while(true)
     {
      int o = StringFind(orders, "{", pos);
      if(o < 0)
         break;
      int c = StringFind(orders, "}", o);
      string obj = StringSubstr(orders, o, c - o + 1);
      pos = c + 1;

      string ref = JsonString(obj, "ref");
      string symbol = JsonString(obj, "symbol");
      string side = JsonString(obj, "side");
      double entry = StringToDouble(JsonRaw(obj, "entry"));
      double sl = StringToDouble(JsonRaw(obj, "sl"));
      double tp = StringToDouble(JsonRaw(obj, "tp"));
      double lot = StringToDouble(JsonRaw(obj, "lot"));

      bool ok = false;
      ulong ticket = 0;
      string error = "";
      if(!SymbolSelect(symbol, true))
         error = "simbol " + symbol + " tidak ada";
      else
        {
         int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
         entry = NormalizeDouble(entry, digits);
         sl = NormalizeDouble(sl, digits);
         tp = NormalizeDouble(tp, digits);
         double vol = NormalizeLot(symbol, lot);
         string what = side + " stop " + symbol + " " + DoubleToString(vol, 2) + " @ " + DoubleToString(entry, digits)
                       + " SL " + DoubleToString(sl, digits) + " TP " + DoubleToString(tp, digits);
         if(DryRun)
           {
            ok = true;
            Print("DavePaul77: DRY-RUN ", what);
           }
         else
           {
            bool sent = side == "buy"
                        ? g_trade.BuyStop(vol, entry, symbol, sl, tp, ORDER_TIME_GTC, 0, ref)
                        : g_trade.SellStop(vol, entry, symbol, sl, tp, ORDER_TIME_GTC, 0, ref);
            uint rc = g_trade.ResultRetcode();
            if(sent && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED))
              {
               ok = true;
               ticket = g_trade.ResultOrder();
               Print("DavePaul77: terpasang #", ticket, " ", what);
              }
            else
              {
               error = IntegerToString(rc) + " " + g_trade.ResultRetcodeDescription();
               Print("DavePaul77: gagal ", what, ": ", error);
              }
           }
        }
      if(ok)
         placed++;
      else
         failed++;
      if(StringLen(results) > 0)
         results += ",";
      results += "{\"ref\":\"" + Escape(ref) + "\",\"ok\":" + (ok ? "true" : "false");
      if(ticket > 0)
         results += ",\"ticket\":" + IntegerToString((long)ticket);
      if(!ok)
         results += ",\"error\":\"" + Escape(error) + "\"";
      results += "}";
     }

   string path = "/api/ea/mt5/commands/" + id + "/result";
   string body = "{\"dryRun\":" + (DryRun ? "true" : "false") + ",\"deleted\":" + IntegerToString(deleted) + ",\"results\":[" + results + "]}";
   string r;
   int code = Http("POST", path, body, r);
   if(code == 200)
      Print("DavePaul77: hasil terkirim, ", placed, " berhasil, ", failed, " gagal");
   else if(code < 400 || code >= 500) // a 4xx will not change on retry
     {
      g_unsentPath = path; // orders are placed already: only the report is retried
      g_unsentBody = body;
     }
  }
//+------------------------------------------------------------------+

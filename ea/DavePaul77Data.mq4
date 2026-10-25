//+------------------------------------------------------------------+
//| DavePaul77Data.mq4                                               |
//| Sends closed D1 candles and bid/ask of the active pairs to the   |
//| DavePaul77 backend. Timer driven (not tick), never trades.       |
//|                                                                  |
//| Setup: Tools > Options > Expert Advisors > Allow WebRequest for  |
//| the server URL. Attach to ONE chart (any symbol/timeframe).      |
//| ServerUrl and DataKey left empty are read from                   |
//| MQL4/Files/DavePaul77.ini (ServerUrl=..., DataKey=...), so the   |
//| key never has to be typed in and stays out of the source.        |
//| After the first run, older D1 history (BackfillBars) is sent once|
//| per pair in chunks, for the backtest. The terminal only has what |
//| it has downloaded: Tools > Options > Charts > Max bars in history|
//| and bars in chart set high, then F2 (History Center) > the pair  |
//| > D1 > Download, before attaching the EA.                        |
//| Horizontal lines drawn on the open charts of a pair are sent as  |
//| the user's own S/R lines (only when they change).                |
//+------------------------------------------------------------------+
#property copyright "DavePaul77"
#property version   "1.10"
#property strict

input string ServerUrl       = "";      // URL server (kosong = dari DavePaul77.ini)
input string DataKey         = "";      // Data key (kosong = dari DavePaul77.ini)
input string SymbolSuffix    = "";      // Akhiran simbol broker, mis. "m" untuk EURUSDm
input string FallbackSymbols = "AUDJPY,AUDUSD,CADJPY,CHFJPY,EURGBP,EURJPY,EURNZD,EURUSD,GBPJPY,GBPUSD,NZDJPY,NZDUSD,USDCAD,USDCHF,USDJPY,XAUUSD"; // used when the server list cannot be read
input int    HistoryBars     = 520;     // closed D1 candles sent on the first run (about 2 years)
input int    BackfillBars    = 5800;    // older D1 candles sent once after the first run (5800 = about 22 years, as far back as the terminal has)
input int    BackfillChunk   = 1000;    // candles per request while backfilling
input bool   RedoBackfill    = false;   // send the old history again even if it was done before
input int    QuoteSeconds    = 60;      // bid/ask interval
input int    ListMinutes     = 5;       // refresh the pair list from the web settings
input int    RetrySeconds    = 60;      // wait after a failed send or history not ready
input int    TimeoutMs       = 30000;   // a sleeping Render free instance can take ~30-50 s to wake
input bool   SendChartLines  = true;    // kirim garis horizontal di chart sebagai garis S/R manual
input int    LinesSeconds    = 60;      // jeda cek perubahan garis

string   g_symbols[];   // app names (without suffix)
datetime g_sent[];      // open time of the last closed D1 candle the server accepted
datetime g_retryAt[];   // per symbol back-off
string   g_linesSig[];  // last horizontal lines accepted by the server, per symbol
int      g_bfNext[];    // backfill: shift of the oldest candle still to send (0 = not started)
bool     g_bfDone[];    // backfill finished (remembered across restarts in a terminal global variable)
datetime g_lastLines  = 0;
datetime g_lastQuotes = 0;
datetime g_lastList   = 0;
string   g_url        = "";
string   g_key        = "";
bool     g_quotesOk   = false;

//+------------------------------------------------------------------+
//| ServerUrl / DataKey: the input when filled, else the ini file     |
//+------------------------------------------------------------------+
void LoadConfig()
  {
   g_url = ServerUrl;
   g_key = DataKey;
   int h = FileOpen("DavePaul77.ini", FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
      return;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      StringTrimLeft(line);
      StringTrimRight(line);
      int eq = StringFind(line, "=");
      if(eq <= 0 || StringGetCharacter(line, 0) == '#')
         continue;
      string key = StringSubstr(line, 0, eq);
      string value = StringSubstr(line, eq + 1);
      if(key == "ServerUrl" && StringLen(g_url) == 0)
         g_url = value;
      if(key == "DataKey" && StringLen(g_key) == 0)
         g_key = value;
     }
   FileClose(h);
   if(StringLen(g_url) > 0 && StringGetCharacter(g_url, StringLen(g_url) - 1) == '/')
      g_url = StringSubstr(g_url, 0, StringLen(g_url) - 1);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   LoadConfig();
   if(StringLen(g_url) == 0 || StringLen(g_key) == 0)
     {
      Alert("DavePaul77: ServerUrl/DataKey kosong. Isi input EA atau file MQL4/Files/DavePaul77.ini");
      return(INIT_PARAMETERS_INCORRECT);
     }
   Print("DavePaul77: server ", g_url);
   EventSetTimer(5);
   RefreshList();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTick() {}

void OnTimer()
  {
   datetime now = TimeLocal();
   if(now - g_lastList >= ListMinutes * 60)
      RefreshList();
   for(int i = 0; i < ArraySize(g_symbols); i++)
      if(now >= g_retryAt[i])
        {
         SendCandles(i);
         if(g_sent[i] > 0 && !g_bfDone[i] && now >= g_retryAt[i])
            Backfill(i);
        }
   if(now - g_lastQuotes >= QuoteSeconds)
     {
      SendQuotes();
      g_lastQuotes = now;
     }
   if(SendChartLines && now - g_lastLines >= LinesSeconds)
     {
      g_lastLines = now;
      for(int i = 0; i < ArraySize(g_symbols); i++)
         SendLines(i);
     }
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
int Http(const string method, const string path, const string body, string &response)
  {
   char data[];
   char result[];
   string resultHeaders;
   // ngrok-skip-browser-warning: the free ngrok domain otherwise answers with an HTML warning page
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
      if(err == 4060)
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
//| Pair list: from the server, falling back to FallbackSymbols       |
//+------------------------------------------------------------------+
void RefreshList()
  {
   g_lastList = TimeLocal();
   string names[];
   string response;
   int count = 0;
   if(Http("GET", "/api/ea/mt4/symbols", "", response) == 200)
     {
      // {"symbols":["AUDJPY","AUDUSD"]}
      int open = StringFind(response, "[");
      int close = StringFind(response, "]", open);
      // close == open + 1 is an empty list; StringSubstr with length 0 would return the rest
      if(open >= 0 && close > open + 1)
        {
         string inner = StringSubstr(response, open + 1, close - open - 1);
         StringReplace(inner, "\"", "");
         StringReplace(inner, " ", "");
         if(StringLen(inner) > 0)
            count = StringSplit(inner, ',', names);
        }
     }
   if(count == 0)
     {
      Print("DavePaul77: daftar pair dari server tidak terbaca, memakai FallbackSymbols");
      string fallback = FallbackSymbols;
      StringReplace(fallback, " ", "");
      count = StringSplit(fallback, ',', names);
     }

   // keep progress for pairs that stay in the list
   string   oldSymbols[];
   datetime oldSent[];
   string   oldSig[];
   ArrayCopy(oldSymbols, g_symbols);
   ArrayCopy(oldSent, g_sent);
   ArrayCopy(oldSig, g_linesSig);
   int oldNext[];
   bool oldDone[];
   ArrayCopy(oldNext, g_bfNext);
   ArrayCopy(oldDone, g_bfDone);
   ArrayResize(g_symbols, count);
   ArrayResize(g_bfNext, count);
   ArrayResize(g_bfDone, count);
   ArrayResize(g_sent, count);
   ArrayResize(g_retryAt, count);
   ArrayResize(g_linesSig, count);
   for(int i = 0; i < count; i++)
     {
      g_symbols[i] = names[i];
      g_sent[i] = 0;
      g_retryAt[i] = 0;
      g_linesSig[i] = "";
      g_bfNext[i] = 0;
      g_bfDone[i] = !RedoBackfill && GlobalVariableCheck("DP77_BF_" + names[i]);
      for(int j = 0; j < ArraySize(oldSymbols); j++)
         if(oldSymbols[j] == names[i])
           {
            g_sent[i] = oldSent[j];
            g_linesSig[i] = oldSig[j];
            g_bfNext[i] = oldNext[j];
            g_bfDone[i] = oldDone[j];
           }
      if(!SymbolSelect(names[i] + SymbolSuffix, true))
         Print("DavePaul77: ", names[i] + SymbolSuffix, " tidak ada di MT4 ini. Cek nama atau SymbolSuffix.");
     }
   Print("DavePaul77: ", count, " pair aktif");
  }

//+------------------------------------------------------------------+
//| Closed D1 candles                                                |
//+------------------------------------------------------------------+
string Num(const double v, const int digits) { return(DoubleToString(v, digits)); }

void SendCandles(const int i)
  {
   string app = g_symbols[i];
   string broker = app + SymbolSuffix;
   ResetLastError();
   int bars = iBars(broker, PERIOD_D1);
   datetime lastClosed = iTime(broker, PERIOD_D1, 1);
   int err = GetLastError();
   if(bars < 3 || lastClosed == 0 || err == 4066) // ERR_HISTORY_WILL_UPDATED: still downloading
     {
      g_retryAt[i] = TimeLocal() + RetrySeconds;
      return;
     }
   if(lastClosed <= g_sent[i])
      return; // nothing new today

   // first run: the whole history window; afterwards only candles after the last one sent
   int last = MathMin(bars - 1, HistoryBars);
   if(g_sent[i] > 0)
     {
      last = 0;
      while(last + 1 < bars && iTime(broker, PERIOD_D1, last + 1) > g_sent[i] && last < 50)
         last++;
     }
   if(last < 1)
      return;

   int digits = (int)MarketInfo(broker, MODE_DIGITS);
   string items = "";
   for(int shift = last; shift >= 1; shift--) // oldest first
     {
      if(StringLen(items) > 0)
         items += ",";
      items += "{\"t\":" + IntegerToString((long)iTime(broker, PERIOD_D1, shift))
               + ",\"o\":" + Num(iOpen(broker, PERIOD_D1, shift), digits)
               + ",\"h\":" + Num(iHigh(broker, PERIOD_D1, shift), digits)
               + ",\"l\":" + Num(iLow(broker, PERIOD_D1, shift), digits)
               + ",\"c\":" + Num(iClose(broker, PERIOD_D1, shift), digits) + "}";
     }
   string body = "{\"symbol\":\"" + app + "\",\"digits\":" + IntegerToString(digits)
                 + ",\"now\":" + IntegerToString((long)TimeCurrent())
                 + ",\"candles\":[" + items + "]}";
   string response;
   if(Http("POST", "/api/ea/mt4/candles", body, response) == 200)
     {
      g_sent[i] = lastClosed;
      Print("DavePaul77: ", app, " ", last, " candle D1 terkirim ", response);
     }
   else
      g_retryAt[i] = TimeLocal() + RetrySeconds;
  }

//+------------------------------------------------------------------+
//| Older history: shifts HistoryBars+1 .. BackfillBars, oldest first, |
//| one chunk per timer tick. Progress is kept in a terminal global   |
//| variable (DP77_BFT_<pair>), so a restart resumes where it stopped. |
//+------------------------------------------------------------------+
void Backfill(const int i)
  {
   string app = g_symbols[i];
   string broker = app + SymbolSuffix;
   ResetLastError();
   int bars = iBars(broker, PERIOD_D1);
   int err = GetLastError();
   if(bars < 3 || err == 4066)
     {
      g_retryAt[i] = TimeLocal() + RetrySeconds;
      return;
     }
   int chunk = MathMax(MathMin(BackfillChunk, 5000), 50);
   if(g_bfNext[i] == 0)
     {
      g_bfNext[i] = MathMin(bars - 1, BackfillBars);
      // a restart resumes after the newest candle already accepted, not from the oldest
      string progress = "DP77_BFT_" + app;
      if(!RedoBackfill && GlobalVariableCheck(progress))
        {
         int sh = iBarShift(broker, PERIOD_D1, (datetime)GlobalVariableGet(progress), true);
         if(sh > 1 && sh - 1 < g_bfNext[i])
            g_bfNext[i] = sh - 1;
        }
      Print("DavePaul77: ", app, " riwayat D1 di terminal ", bars, " candle (sekitar ", DoubleToString(bars / 260.0, 1), " tahun); backfill sampai ", g_bfNext[i]);
     }
   if(g_bfNext[i] <= HistoryBars)
     {
      g_bfDone[i] = true;
      GlobalVariableSet("DP77_BF_" + app, 1);
      Print("DavePaul77: ", app, " backfill selesai");
      return;
     }
   int from = g_bfNext[i];                              // oldest shift of this chunk
   int to = MathMax(from - chunk + 1, HistoryBars + 1); // newest shift of this chunk
   int digits = (int)MarketInfo(broker, MODE_DIGITS);
   string items = "";
   int n = 0;
   for(int shift = from; shift >= to; shift--)
     {
      datetime t = iTime(broker, PERIOD_D1, shift);
      if(t == 0)
         continue;
      if(StringLen(items) > 0)
         items += ",";
      items += "{\"t\":" + IntegerToString((long)t)
               + ",\"o\":" + Num(iOpen(broker, PERIOD_D1, shift), digits)
               + ",\"h\":" + Num(iHigh(broker, PERIOD_D1, shift), digits)
               + ",\"l\":" + Num(iLow(broker, PERIOD_D1, shift), digits)
               + ",\"c\":" + Num(iClose(broker, PERIOD_D1, shift), digits) + "}";
      n++;
     }
   if(n == 0)
     {
      g_bfNext[i] = to - 1;
      return;
     }
   string body = "{\"symbol\":\"" + app + "\",\"digits\":" + IntegerToString(digits)
                 + ",\"now\":" + IntegerToString((long)TimeCurrent())
                 + ",\"backfill\":true,\"candles\":[" + items + "]}";
   string response;
   if(Http("POST", "/api/ea/mt4/candles", body, response) == 200)
     {
      GlobalVariableSet("DP77_BFT_" + app, (double)iTime(broker, PERIOD_D1, to));
      g_bfNext[i] = to - 1;
      Print("DavePaul77: ", app, " backfill ", n, " candle terkirim, sisa ", MathMax(g_bfNext[i] - HistoryBars, 0), " ", response);
     }
   else
      g_retryAt[i] = TimeLocal() + RetrySeconds;
  }

//+------------------------------------------------------------------+
//| The user's S/R: horizontal lines on every open chart of the pair  |
//| Pairs without an open chart are skipped (the server keeps what it |
//| has); a chart without lines clears them (back to automatic).      |
//+------------------------------------------------------------------+
void SendLines(const int i)
  {
   string broker = g_symbols[i] + SymbolSuffix;
   double prices[];
   int n = 0;
   bool found = false;
   for(long chart = ChartFirst(); chart >= 0; chart = ChartNext(chart))
     {
      if(ChartSymbol(chart) != broker)
         continue;
      found = true;
      int total = ObjectsTotal(chart, 0, OBJ_HLINE);
      for(int k = 0; k < total; k++)
        {
         string name = ObjectName(chart, k, 0, OBJ_HLINE);
         double price = ObjectGetDouble(chart, name, OBJPROP_PRICE, 0);
         if(price <= 0)
            continue;
         ArrayResize(prices, n + 1);
         prices[n++] = price;
        }
     }
   if(!found)
      return;
   ArraySort(prices);
   int digits = (int)MarketInfo(broker, MODE_DIGITS);
   string items = "";
   string last = "";
   for(int k = 0; k < n; k++)
     {
      string v = Num(prices[k], digits + 1);
      if(v == last)
         continue; // the same line on two charts
      last = v;
      if(StringLen(items) > 0)
         items += ",";
      items += v;
     }
   if(items == g_linesSig[i])
      return;
   string response;
   if(Http("POST", "/api/ea/mt4/lines", "{\"symbol\":\"" + g_symbols[i] + "\",\"lines\":[" + items + "]}", response) == 200)
     {
      g_linesSig[i] = items;
      Print("DavePaul77: ", g_symbols[i], " garis S/R dari chart terkirim ", response);
     }
  }

//+------------------------------------------------------------------+
//| Bid/ask of every active pair in one request                      |
//+------------------------------------------------------------------+
void SendQuotes()
  {
   string items = "";
   for(int i = 0; i < ArraySize(g_symbols); i++)
     {
      string broker = g_symbols[i] + SymbolSuffix;
      double bid = MarketInfo(broker, MODE_BID);
      double ask = MarketInfo(broker, MODE_ASK);
      if(bid <= 0 || ask <= 0)
         continue;
      int digits = (int)MarketInfo(broker, MODE_DIGITS);
      if(StringLen(items) > 0)
         items += ",";
      items += "{\"symbol\":\"" + g_symbols[i] + "\",\"bid\":" + Num(bid, digits) + ",\"ask\":" + Num(ask, digits) + "}";
     }
   if(StringLen(items) == 0)
      return;
   string response;
   int code = Http("POST", "/api/ea/mt4/quotes", "{\"now\":" + IntegerToString((long)TimeCurrent()) + ",\"quotes\":[" + items + "]}", response);
   if(code == 200 && !g_quotesOk)
      Print("DavePaul77: bid/ask terkirim ", response); // once, to show the connection works
   g_quotesOk = (code == 200);
  }
//+------------------------------------------------------------------+

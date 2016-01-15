#include <sourcemod>
#include <connect>
#include <sdktools>
#include <steamtools>
#include <tf2>
#include <tf2_stocks>

#pragma newdecls required

public Plugin myinfo = {
    name = "PugChamp Control",
    author = "Forward Command Post",
    description = "a plugin allowing server control by and communication with a PugChamp central server",
    version = "0.0.0",
    url = "http://pug.champ.gg"
};

ConVar serverURL;

bool gameAssigned;
bool gameLive;
float gameStartTime;

ConVar gameID;
ConVar gameMap;
ConVar gameConfig;

ArrayList allowedPlayers;
StringMap playerNames;
StringMap playerTeams;
StringMap playerClasses;
StringMap playerStartTimes;
StringMap playerPlaytimes;

public void OnPluginStart() {
    serverURL = CreateConVar("pugchamp_server_url", "", "the server URL to which game info is sent", FCVAR_PROTECTED|FCVAR_DONTRECORD|FCVAR_PLUGIN);

    RegServerCmd("pugchamp_game_info", Command_GameInfo, "replies with current game info");

    RegServerCmd("pugchamp_game_reset", Command_GameReset, "resets a currently active game");
    RegServerCmd("pugchamp_game_start", Command_GameStart, "starts a new game");

    gameAssigned = false;
    gameLive = false;
    gameStartTime = -1.0;

    gameID = CreateConVar("pugchamp_game_id", "", "the ID for the current game", FCVAR_PROTECTED|FCVAR_DONTRECORD|FCVAR_PLUGIN);
    gameMap = CreateConVar("pugchamp_game_map", "", "the map for the current game", FCVAR_PLUGIN);
    gameConfig = CreateConVar("pugchamp_game_config", "", "the config for the current game", FCVAR_PLUGIN);

    RegServerCmd("pugchamp_game_player_add", Command_GamePlayerAdd, "adds a player to a game");
    RegServerCmd("pugchamp_game_player_remove", Command_GamePlayerRemove, "removes a player from a game");

    allowedPlayers = new ArrayList(32);
    playerNames = new StringMap();
    playerTeams = new StringMap();
    playerClasses = new StringMap();
    playerStartTimes = new StringMap();
    playerPlaytimes = new StringMap();

    HookEvent("teamplay_restart_round", Event_GameStart, EventHookMode_PostNoCopy);
    HookEvent("teamplay_game_over", Event_GameOver, EventHookMode_PostNoCopy);
    HookEvent("tf_game_over", Event_GameOver, EventHookMode_PostNoCopy);

    HookEvent("player_changename", Event_NameChange, EventHookMode_Post);
    HookUserMessage(GetUserMessageId("SayText2"), UserMessage_SayText2, true);
}

public void OnMapStart() {
    if (gameAssigned) {
        char config[PLATFORM_MAX_PATH];
        gameConfig.GetString(config, sizeof(config));

        ServerCommand("exec %s", config);

        char url[2048];
        serverURL.GetString(url, sizeof(url));
        HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

        char id[32];
        gameID.GetString(id, sizeof(id));
        Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "game", id);

        Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "status", "setup");

        Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned);
    }
}

public bool OnClientPreConnectEx(const char[] name, char password[255], const char[] ip, const char[] steamID, char rejectReason[255]) {
    char steamID64[32];
    Connect_GetAuthId(AuthId_SteamID64, steamID64, sizeof(steamID64));

    if (allowedPlayers.FindString(steamID64) == -1) {
        strcopy(rejectReason, sizeof(rejectReason), "You are not authorized to join this server.");

        return false;
    }

    return true;
}

public void OnClientPostAdminCheck(int client) {
    char steamID[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, steamID, sizeof(steamID))) {
        ThrowError("Steam ID not retrieved");
    }

    char name[32];
    if (playerNames.GetString(steamID, name, sizeof(name))) {
        SetClientName(client, name);
    }

    int team;
    if (playerTeams.GetValue(steamID, team)) {
        ChangeClientTeam(client, team);
    }

    TFClassType class;
    if (playerClasses.GetValue(steamID, class)) {
        TF2_SetPlayerClass(client, class, _, true);
    }

    if (gameAssigned && gameLive) {
        StartPlayerTimer(client);
    }
}

public void OnClientDisconnect(int client) {
    if (gameAssigned && gameLive) {
        EndPlayerTimer(client);
    }
}

public void OnClientDisconnect_Post(int client) {
    if (gameAssigned && gameLive) {
        if (GetTeamClientCount(2) + GetTeamClientCount(3) == 0) {
            gameLive = false;

            for (int i = 1; i <= MaxClients; i++) {
                if (IsClientConnected(i) && IsClientAuthorized(i)) {
                    EndPlayerTimer(i);
                }
            }

            char url[2048];
            serverURL.GetString(url, sizeof(url));
            HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

            char id[32];
            gameID.GetString(id, sizeof(id));
            Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "game", id);

            Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "status", "abandoned");

            char score[4];
            IntToString(GetTeamScore(2), score, sizeof(score));
            Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "score[RED]", score);
            IntToString(GetTeamScore(3), score, sizeof(score));
            Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "score[BLU]", score);

            if (gameStartTime != -1.0) {
                char duration[128];
                FloatToString(GetGameTime() - gameStartTime, duration, sizeof(duration));
                Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "duration", duration);
            }

            StringMapSnapshot players = playerPlaytimes.Snapshot();
            for (int i = 0; i < players.Length; i++) {
                char steamID[32];
                players.GetKey(i, steamID, sizeof(steamID));

                float playtime;
                if (playerPlaytimes.GetValue(steamID, playtime)) {
                    char key[64];
                    Format(key, sizeof(key), "time[%s]", steamID);

                    char value[128];
                    FloatToString(playtime, value, sizeof(value));

                    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, key, value);
                }
            }

            Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned);
        }
    }
}

public Action Command_GameInfo(int args) {
    char id[32];
    gameID.GetString(id, sizeof(id));

    ReplyToCommand(0, "%s", id);

    return Plugin_Handled;
}

public Action Command_GameReset(int args) {
    allowedPlayers.Clear();
    playerNames.Clear();
    playerTeams.Clear();
    playerClasses.Clear();
    playerStartTimes.Clear();
    playerPlaytimes.Clear();

    gameAssigned = false;
    gameLive = false;
    gameStartTime = -1.0;
    gameID.SetString("");
    gameMap.SetString("");
    gameConfig.SetString("");

    for (int i = 1; i <= MaxClients; i++) {
        if (IsClientConnected(i) && !IsClientReplay(i) && !IsClientSourceTV(i)) {
            KickClient(i, "the server is being reset");
        }
    }

    return Plugin_Handled;
}

public Action Command_GameStart(int args) {
    gameAssigned = true;

    char map[PLATFORM_MAX_PATH];
    gameMap.GetString(map, sizeof(map));

    ServerCommand("changelevel %s", map);

    return Plugin_Handled;
}

public Action Command_GamePlayerAdd(int args) {
    char steamID[32];
    GetCmdArg(1, steamID, sizeof(steamID));
    if (allowedPlayers.FindString(steamID) == -1) {
        allowedPlayers.PushString(steamID);
    }

    char name[32];
    GetCmdArg(2, name, sizeof(name));
    playerNames.SetString(steamID, name, true);

    if (args >= 3) {
        char teamString[4];
        int team;
        GetCmdArg(3, teamString, sizeof(teamString));
        team = StringToInt(teamString);
        playerTeams.SetValue(steamID, team, true);

        if (args >= 4) {
            char classString[4];
            int class;
            GetCmdArg(4, classString, sizeof(classString));
            class = StringToInt(classString);
            playerClasses.SetValue(steamID, class, true);
        }
    }

    playerPlaytimes.SetValue(steamID, 0.0, false);
}

public Action Command_GamePlayerRemove(int args) {
    char steamID[32];
    GetCmdArg(1, steamID, sizeof(steamID));

    if (allowedPlayers.FindString(steamID) != -1) {
        allowedPlayers.Erase(allowedPlayers.FindString(steamID));
    }
    playerNames.Remove(steamID);
    playerTeams.Remove(steamID);
    playerClasses.Remove(steamID);

    for (int i = 1; i <= MaxClients; i++) {
        if (IsClientConnected(i) && !IsClientReplay(i) && !IsClientSourceTV(i)) {
            char clientSteamID[32];
            if (GetClientAuthId(i, AuthId_SteamID64, clientSteamID, sizeof(clientSteamID))) {
                if (StrEqual(steamID, clientSteamID)) {
                    KickClient(i, "you have been removed from this game");
                }
            }
        }
    }
}

public void Event_GameStart(Event event, const char[] name, bool dontBroadcast) {
    gameLive = true;
    gameStartTime = GetGameTime();

    for (int i = 1; i <= MaxClients; i++) {
        if (IsClientConnected(i) && IsClientAuthorized(i)) {
            StartPlayerTimer(i);
        }
    }

    char url[2048];
    serverURL.GetString(url, sizeof(url));
    HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    char id[32];
    gameID.GetString(id, sizeof(id));
    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "game", id);

    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "status", "live");

    Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned);
}

public void Event_GameOver(Event event, const char[] name, bool dontBroadcast) {
    gameLive = false;

    for (int i = 1; i <= MaxClients; i++) {
        if (IsClientConnected(i) && IsClientAuthorized(i)) {
            EndPlayerTimer(i);
        }
    }

    char url[2048];
    serverURL.GetString(url, sizeof(url));
    HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    char id[32];
    gameID.GetString(id, sizeof(id));
    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "game", id);

    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "status", "completed");

    char score[4];
    IntToString(GetTeamScore(2), score, sizeof(score));
    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "score[RED]", score);
    IntToString(GetTeamScore(3), score, sizeof(score));
    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "score[BLU]", score);

    if (gameStartTime != -1.0) {
        char duration[128];
        FloatToString(GetGameTime() - gameStartTime, duration, sizeof(duration));
        Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "duration", duration);
    }

    StringMapSnapshot players = playerPlaytimes.Snapshot();
    for (int i = 0; i < players.Length; i++) {
        char steamID[32];
        players.GetKey(i, steamID, sizeof(steamID));

        float playtime;
        if (playerPlaytimes.GetValue(steamID, playtime)) {
            char key[64];
            Format(key, sizeof(key), "time[%s]", steamID);

            char value[128];
            FloatToString(playtime, value, sizeof(value));

            Steam_SetHTTPRequestGetOrPostParameter(httpRequest, key, value);
        }
    }

    Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned);
}

public void Event_NameChange(Event event, const char[] name, bool dontBroadcast) {
    int client = GetClientOfUserId(event.GetInt("userid"));

    char newName[32];
    event.GetString("newname", newName, sizeof(newName));

    char steamID[32];
    GetClientAuthId(client, AuthId_SteamID64, steamID, sizeof(steamID));

    char playerName[32];
    if (playerNames.GetString(steamID, playerName, sizeof(playerName))) {
        if (!StrEqual(newName, playerName)) {
            SetClientName(client, playerName);
        }
    }
}

public Action UserMessage_SayText2(UserMsg msg_id, BfRead msg, const int[] players, int playersNum, bool reliable, bool init) {
    char buffer[512];

    if (!reliable) {
        return Plugin_Continue;
    }

    msg.ReadByte();
    msg.ReadByte();
    msg.ReadString(buffer, sizeof(buffer), false);

    if (StrContains(buffer, "#TF_Name_Change") != -1) {
        return Plugin_Handled;
    }

    return Plugin_Continue;
}

public void LogUploaded(bool success, const char[] logid, const char[] logurl) {
    char url[2048];
    serverURL.GetString(url, sizeof(url));
    HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    char id[32];
    gameID.GetString(id, sizeof(id));
    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "game", id);

    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "status", "logavailable");

    Steam_SetHTTPRequestGetOrPostParameter(httpRequest, "url", logurl);

    Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned);
}

public int HTTPRequestReturned(HTTPRequestHandle HTTPRequest, bool requestSuccessful, HTTPStatusCode statusCode) {
    Steam_ReleaseHTTPRequest(HTTPRequest);

    if (!requestSuccessful) {
        ThrowError("HTTP request failed");
    }
    else if (statusCode != HTTPStatusCode_OK) {
        ThrowError("HTTP request failed with code %i", statusCode);
    }
}

void StartPlayerTimer(int client) {
    char steamID[32];
    GetClientAuthId(client, AuthId_SteamID64, steamID, sizeof(steamID));

    playerStartTimes.SetValue(steamID, GetGameTime(), false);
}

void EndPlayerTimer(int client) {
    char steamID[32];
    GetClientAuthId(client, AuthId_SteamID64, steamID, sizeof(steamID));

    float startTime = -1.0;
    if (playerStartTimes.GetValue(steamID, startTime) && startTime != -1.0) {
        float currentPlaytime = GetGameTime() - startTime;

        playerStartTimes.Remove(steamID);

        float previousPlaytime;
        if (playerPlaytimes.GetValue(steamID, previousPlaytime)) {
            playerPlaytimes.SetValue(steamID, previousPlaytime + currentPlaytime, true);
        }
        else {
            playerPlaytimes.SetValue(steamID, currentPlaytime, true);
        }
    }
}

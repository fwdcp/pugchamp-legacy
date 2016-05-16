#include <sourcemod>
#include <demostf>
#include <logstf>
#include <morecolors>
#include <sdktools>
#include <steamtools>
#include <tf2>
#include <tf2_stocks>

#pragma newdecls required

#define MAX_RETRIES 3
#define RETRY_INTERVAL 5.0

public Plugin myinfo = {
    name = "PugChamp Control",
    author = "Forward Command Post",
    description = "a plugin allowing server control by and communication with a PugChamp central server",
    version = "0.0.0",
    url = "http://pug.champ.gg"
};

ConVar gameInfo;

ConVar apiURL;

ConVar serverDelegated;

bool gameAssigned;
bool gameLive;
bool gameCompleted;
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
    gameInfo = CreateConVar("pugchamp_game_info", "", "the current game info", FCVAR_NOTIFY|FCVAR_PLUGIN);

    apiURL = CreateConVar("pugchamp_api_url", "", "the API URL to which game info is sent", FCVAR_PROTECTED|FCVAR_DONTRECORD|FCVAR_PLUGIN);

    serverDelegated = CreateConVar("pugchamp_server_delegated", "1", "whether the server is currently delegated to the PugChamp service", FCVAR_PLUGIN, true, 0.0, true, 1.0);
    serverDelegated.AddChangeHook(Hook_DelegationStatusChanged);

    RegServerCmd("pugchamp_game_reset", Command_GameReset, "resets a currently active game");
    RegServerCmd("pugchamp_game_start", Command_GameStart, "starts a new game");

    gameAssigned = false;
    gameLive = false;
    gameCompleted = false;
    gameStartTime = -1.0;

    gameID = CreateConVar("pugchamp_game_id", "", "the ID for the current game", FCVAR_PLUGIN);
    gameID.AddChangeHook(Hook_GameIDChanged);
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
    HookEvent("teamplay_round_active", Event_RoundStart, EventHookMode_PostNoCopy);

    HookEvent("player_changename", Event_NameChange, EventHookMode_Post);
    HookUserMessage(GetUserMessageId("SayText2"), UserMessage_SayText2, true);

    UpdateGameInfo();
}

public void OnMapStart() {
    if (gameAssigned) {
        char config[PLATFORM_MAX_PATH];
        gameConfig.GetString(config, sizeof(config));

        ServerCommand("exec %s", config);

        StringMap parameters = new StringMap();

        char id[32];
        gameID.GetString(id, sizeof(id));
        parameters.SetString("game", id);

        parameters.SetString("status", "setup");

        SendRequest(parameters, 0);
    }
}

public void OnClientAuthorized(int client) {
    char currentGameInfo[32];
    gameInfo.GetString(currentGameInfo, sizeof(currentGameInfo));

    if (!StrEqual(currentGameInfo, "UNAVAILABLE")) {
        char steamID[32];
        if (!GetClientAuthId(client, AuthId_SteamID64, steamID, sizeof(steamID)) || allowedPlayers.FindString(steamID) == -1) {
            KickClient(client, "you are not authorized to join this server");
        }
    }
}

public void OnClientPostAdminCheck(int client) {
    char steamID[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, steamID, sizeof(steamID))) {
        char name[32];
        GetClientName(client, name, sizeof(name));
        CPrintToChatAll("{green}[PugChamp]{default} Unable to recognize {olive}%s{default}!", name, steamID);

        ThrowError("Steam ID not retrieved");
    }

    char name[32];
    if (playerNames.GetString(steamID, name, sizeof(name))) {
        SetClientName(client, name);
    }
    else {
        GetClientName(client, name, sizeof(name));
        CPrintToChatAll("{green}[PugChamp]{default} Unable to recognize {olive}%s{default} (Steam ID {olive}%s{default})!", name, steamID);
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

public void Hook_DelegationStatusChanged(ConVar convar, const char[] oldValue, const char[] newValue) {
    if (gameAssigned && !serverDelegated.BoolValue) {
        PrintToServer("Warning: the server is currently assigned to a game and will not be free until reset.");
    }

    UpdateGameInfo();
}

public void Hook_GameIDChanged(ConVar convar, const char[] oldValue, const char[] newValue) {
    UpdateGameInfo();
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
    gameCompleted = false;
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
    if (gameAssigned && !gameLive && !gameCompleted) {
        gameLive = true;
        gameStartTime = GetGameTime();

        for (int i = 1; i <= MaxClients; i++) {
            if (IsClientConnected(i) && IsClientAuthorized(i)) {
                StartPlayerTimer(i);
            }
        }

        StringMap parameters = new StringMap();

        char id[32];
        gameID.GetString(id, sizeof(id));
        parameters.SetString("game", id);

        parameters.SetString("status", "live");

        SendRequest(parameters, 0);

        ServerCommand("tv_stoprecord");
        ServerCommand("tv_record pugchamp-%s", id);
    }
}

public void Event_GameOver(Event event, const char[] name, bool dontBroadcast) {
    if (gameAssigned && gameLive && !gameCompleted) {
        gameLive = false;
        gameCompleted = true;

        for (int i = 1; i <= MaxClients; i++) {
            if (IsClientConnected(i) && IsClientAuthorized(i)) {
                EndPlayerTimer(i);
            }
        }

        StringMap parameters = new StringMap();

        char id[32];
        gameID.GetString(id, sizeof(id));
        parameters.SetString("game", id);

        parameters.SetString("status", "completed");

        char score[4];
        IntToString(GetTeamScore(2), score, sizeof(score));
        parameters.SetString("score[RED]", score);
        IntToString(GetTeamScore(3), score, sizeof(score));
        parameters.SetString("score[BLU]", score);

        if (gameStartTime != -1.0) {
            char duration[128];
            FloatToString(GetGameTime() - gameStartTime, duration, sizeof(duration));
            parameters.SetString("duration", duration);
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

                parameters.SetString(key, value);
            }
        }

        SendRequest(parameters, 0);

        ServerCommand("tv_stoprecord");
    }
}

public void Event_RoundStart(Event event, const char[] name, bool dontBroadcast) {
    if (gameAssigned && gameLive && !gameCompleted) {
        StringMap parameters = new StringMap();

        char id[32];
        gameID.GetString(id, sizeof(id));
        parameters.SetString("game", id);

        parameters.SetString("status", "live");

        char score[4];
        IntToString(GetTeamScore(2), score, sizeof(score));
        parameters.SetString("score[RED]", score);
        IntToString(GetTeamScore(3), score, sizeof(score));
        parameters.SetString("score[BLU]", score);

        if (gameStartTime != -1.0) {
            char duration[128];
            FloatToString(GetGameTime() - gameStartTime, duration, sizeof(duration));
            parameters.SetString("duration", duration);
        }

        for (int i = 1; i <= MaxClients; i++) {
            if (IsClientConnected(i) && IsClientAuthorized(i)) {
                EndPlayerTimer(i);
            }
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

                parameters.SetString(key, value);
            }
        }

        for (int i = 1; i <= MaxClients; i++) {
            if (IsClientConnected(i) && IsClientAuthorized(i)) {
                StartPlayerTimer(i);
            }
        }

        SendRequest(parameters, 0);
    }
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
    if (gameAssigned) {
        if (success) {
            StringMap parameters = new StringMap();

            char id[32];
            gameID.GetString(id, sizeof(id));
            parameters.SetString("game", id);

            parameters.SetString("status", "logavailable");

            parameters.SetString("url", logurl);

            SendRequest(parameters, 0);
        }
    }
}

public void DemoUploaded(bool success, const char[] demourl) {
    if (gameAssigned) {
        if (success) {
            StringMap parameters = new StringMap();

            char id[32];
            gameID.GetString(id, sizeof(id));
            parameters.SetString("game", id);

            parameters.SetString("status", "demoavailable");

            parameters.SetString("url", demourl);

            SendRequest(parameters, 0);
        }
    }
}

public int HTTPRequestReturned(HTTPRequestHandle HTTPRequest, bool requestSuccessful, HTTPStatusCode statusCode, any contextData) {
    DataPack datapack = view_as<DataPack>(contextData);
    datapack.Reset();
    StringMap parameters = view_as<StringMap>(datapack.ReadCell());
    int numRetries = datapack.ReadCell();

    if (!requestSuccessful || statusCode != HTTPStatusCode_OK) {
        if (!requestSuccessful) {
            LogError("HTTP request failed");
        }

        if (statusCode != HTTPStatusCode_OK) {
            LogError("HTTP request failed with code %i", statusCode);
        }

        if (numRetries < MAX_RETRIES) {
            numRetries++;

            DataPack timerData;

            CreateDataTimer(RETRY_INTERVAL * numRetries, RetryRequest, timerData);

            timerData.WriteCell(CloneHandle(parameters));
            timerData.WriteCell(numRetries);
        }
    }

    CloseHandle(parameters);
    CloseHandle(datapack);

    Steam_ReleaseHTTPRequest(HTTPRequest);
}

public Action RetryRequest(Handle timer, Handle hndl) {
    DataPack datapack = view_as<DataPack>(hndl);
    datapack.Reset();
    StringMap parameters = view_as<StringMap>(datapack.ReadCell());
    int numRetries = datapack.ReadCell();

    SendRequest(parameters, numRetries);
}

void SendRequest(StringMap parameters, int numRetries) {
    char url[2048];
    apiURL.GetString(url, sizeof(url));
    HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_POST, url);

    StringMapSnapshot keys = parameters.Snapshot();

    for (int i = 0; i < keys.Length; i++) {
        char key[1024];
        char value[1024];

        keys.GetKey(i, key, sizeof(key));
        parameters.GetString(key, value, sizeof(value));

        Steam_SetHTTPRequestGetOrPostParameter(httpRequest, key, value);
    }

    DataPack datapack = new DataPack();
    datapack.WriteCell(parameters);
    datapack.WriteCell(numRetries);

    Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned, datapack);
}

void UpdateGameInfo() {
    char id[32];
    gameID.GetString(id, sizeof(id));

    if (!StrEqual(id, "")) {
        gameInfo.SetString(id);
    }
    else {
        if (serverDelegated.BoolValue) {
            gameInfo.SetString("FREE");
        }
        else {
            gameInfo.SetString("UNAVAILABLE");
        }
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

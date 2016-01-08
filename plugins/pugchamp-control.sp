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

bool matchAssigned;
bool matchLive;

ConVar matchID;
ConVar matchMap;
ConVar matchConfig;

ArrayList allowedPlayers;
StringMap playerNames;
StringMap playerTeams;
StringMap playerClasses;

public void OnPluginStart() {
    serverURL = CreateConVar("pugchamp_server_url", "", "the server URL to which match info is sent", FCVAR_PROTECTED|FCVAR_DONTRECORD|FCVAR_PLUGIN);

    RegServerCmd("pugchamp_match_info", Command_MatchInfo, "replies with current match info");

    RegServerCmd("pugchamp_match_reset", Command_MatchReset, "resets a currently active match");
    RegServerCmd("pugchamp_match_start", Command_MatchStart, "starts a new match");

    matchAssigned = false;
    matchLive = false;

    matchID = CreateConVar("pugchamp_match_id", "", "the match ID for the current match", FCVAR_PROTECTED|FCVAR_DONTRECORD|FCVAR_PLUGIN);
    matchMap = CreateConVar("pugchamp_match_map", "", "the map for the current match", FCVAR_PLUGIN);
    matchConfig = CreateConVar("pugchamp_match_config", "", "the config for the current match", FCVAR_PLUGIN);

    RegServerCmd("pugchamp_match_player_add", Command_MatchPlayerAdd, "adds a player to a match");
    RegServerCmd("pugchamp_match_player_remove", Command_MatchPlayerRemove, "removes a player from a match");

    allowedPlayers = new ArrayList(32);
    playerNames = new StringMap();
    playerTeams = new StringMap();
    playerClasses = new StringMap();

    HookEvent("teamplay_restart_round", Event_GameStart, EventHookMode_PostNoCopy);
    HookEvent("teamplay_game_over", Event_GameOver, EventHookMode_PostNoCopy);
    HookEvent("tf_game_over", Event_GameOver, EventHookMode_PostNoCopy);

    HookEvent("player_changename", Event_NameChange, EventHookMode_Post);
    HookUserMessage(GetUserMessageId("SayText2"), UserMessage_SayText2, true);
}

public void OnMapStart() {
    if (matchAssigned) {
        char config[PLATFORM_MAX_PATH];
        matchConfig.GetString(config, sizeof(config));

        ServerCommand("exec %s", config);

        char url[2048];
        serverURL.GetString(url, sizeof(url));
        HTTPRequestHandle resultReport = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

        char id[32];
        matchID.GetString(id, sizeof(id));
        Steam_SetHTTPRequestGetOrPostParameter(resultReport, "match", id);

        Steam_SetHTTPRequestGetOrPostParameter(resultReport, "status", "setup");

        Steam_SendHTTPRequest(resultReport, HTTPRequestReturned);
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
}

public void OnClientDisconnect_Post(int client) {
    if (matchAssigned && matchLive) {
        if (GetTeamClientCount(2) + GetTeamClientCount(3) == 0) {
            matchLive = false;

            char url[2048];
            serverURL.GetString(url, sizeof(url));
            HTTPRequestHandle resultReport = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

            char id[32];
            matchID.GetString(id, sizeof(id));
            Steam_SetHTTPRequestGetOrPostParameter(resultReport, "match", id);

            Steam_SetHTTPRequestGetOrPostParameter(resultReport, "status", "abandoned");

            char score[4];
            IntToString(GetTeamScore(2), score, sizeof(score));
            Steam_SetHTTPRequestGetOrPostParameter(resultReport, "redscore", score);
            IntToString(GetTeamScore(3), score, sizeof(score));
            Steam_SetHTTPRequestGetOrPostParameter(resultReport, "bluscore", score);

            Steam_SendHTTPRequest(resultReport, HTTPRequestReturned);
        }
    }
}

public Action Command_MatchInfo(int args) {
    char id[32];
    matchID.GetString(id, sizeof(id));

    ReplyToCommand(0, "%s", id);

    return Plugin_Handled;
}

public Action Command_MatchReset(int args) {
    allowedPlayers.Clear();
    playerNames.Clear();
    playerTeams.Clear();
    playerClasses.Clear();

    matchAssigned = false;
    matchLive = false;
    matchID.SetString("");
    matchMap.SetString("");
    matchConfig.SetString("");

    for (int i = 1; i < MaxClients; i++) {
        if (IsClientConnected(i) && !IsClientReplay(i) && !IsClientSourceTV(i)) {
            KickClient(i, "the server is being reset");
        }
    }

    return Plugin_Handled;
}

public Action Command_MatchStart(int args) {
    matchAssigned = true;

    char map[PLATFORM_MAX_PATH];
    matchMap.GetString(map, sizeof(map));

    ServerCommand("changelevel %s", map);

    return Plugin_Handled;
}

public Action Command_MatchPlayerAdd(int args) {
    char steamID[32];
    GetCmdArg(1, steamID, sizeof(steamID));
    if (allowedPlayers.FindString(steamID) == -1) {
        allowedPlayers.PushString(steamID);
    }

    char name[32];
    GetCmdArg(2, name, sizeof(name));
    playerNames.SetString(steamID, name);

    if (args >= 3) {
        char teamString[4];
        int team;
        GetCmdArg(3, teamString, sizeof(teamString));
        team = StringToInt(teamString);
        playerTeams.SetValue(steamID, team);

        if (args >= 4) {
            char classString[4];
            int class;
            GetCmdArg(4, classString, sizeof(classString));
            class = StringToInt(classString);
            playerClasses.SetValue(steamID, class);
        }
    }
}

public Action Command_MatchPlayerRemove(int args) {
    char steamID[32];
    GetCmdArg(1, steamID, sizeof(steamID));

    if (allowedPlayers.FindString(steamID) != -1) {
        allowedPlayers.Erase(allowedPlayers.FindString(steamID));
    }
    playerNames.Remove(steamID);
    playerTeams.Remove(steamID);
    playerClasses.Remove(steamID);
}

public void Event_GameStart(Event event, const char[] name, bool dontBroadcast) {
    matchLive = true;

    char url[2048];
    serverURL.GetString(url, sizeof(url));
    HTTPRequestHandle resultReport = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    char id[32];
    matchID.GetString(id, sizeof(id));
    Steam_SetHTTPRequestGetOrPostParameter(resultReport, "match", id);

    Steam_SetHTTPRequestGetOrPostParameter(resultReport, "status", "live");

    Steam_SendHTTPRequest(resultReport, HTTPRequestReturned);
}

public void Event_GameOver(Event event, const char[] name, bool dontBroadcast) {
    matchLive = false;

    char url[2048];
    serverURL.GetString(url, sizeof(url));
    HTTPRequestHandle resultReport = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    char id[32];
    matchID.GetString(id, sizeof(id));
    Steam_SetHTTPRequestGetOrPostParameter(resultReport, "match", id);

    Steam_SetHTTPRequestGetOrPostParameter(resultReport, "status", "completed");

    char score[4];
    IntToString(GetTeamScore(2), score, sizeof(score));
    Steam_SetHTTPRequestGetOrPostParameter(resultReport, "redscore", score);
    IntToString(GetTeamScore(3), score, sizeof(score));
    Steam_SetHTTPRequestGetOrPostParameter(resultReport, "bluscore", score);

    Steam_SendHTTPRequest(resultReport, HTTPRequestReturned);
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

public int HTTPRequestReturned(HTTPRequestHandle HTTPRequest, bool requestSuccessful, HTTPStatusCode statusCode) {
    Steam_ReleaseHTTPRequest(HTTPRequest);

    if (!requestSuccessful || statusCode != HTTPStatusCode_OK) {
        ThrowError("HTTP request failed");
    }
}

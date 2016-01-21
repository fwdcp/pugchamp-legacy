#include <sourcemod>
#include <morecolors>
#include <steamtools>

#pragma newdecls required

public Plugin myinfo = {
    name = "whitelist.tf",
    author = "Forward Command Post",
    description = "a plugin automatically downloading whitelists from whitelist.tf",
    version = "0.1.0",
    url = "http://whitelist.tf"
};

ConVar gameWhitelist;
ConVar whitelistID;

public void OnPluginStart() {
    whitelistID = CreateConVar("whitelisttf_whitelist_id", "", "the ID of the whitelist to use", FCVAR_NOTIFY|FCVAR_DEMO|FCVAR_PLUGIN);
    whitelistID.AddChangeHook(Hook_WhitelistChanged);

    gameWhitelist = FindConVar("mp_tournament_whitelist");

    RegServerCmd("whitelisttf_whitelist_reload", Command_ReloadWhitelist, "reloads the whitelist");

    DownloadWhitelist();
}

public Action Command_ReloadWhitelist(int args) {
    DownloadWhitelist();
}

public void Hook_WhitelistChanged(ConVar convar, const char[] oldValue, const char[] newValue) {
    DownloadWhitelist();
}

void DownloadWhitelist() {
    char id[64];
    whitelistID.GetString(id, sizeof(id));

    if (strlen(id) == 0) {
        return;
    }

    char url[2048];
    Format(url, sizeof(url), "http://whitelist.tf/%s.txt", id);

    HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned, 0);
}

void DownloadCustomWhitelist() {
    char id[64];
    whitelistID.GetString(id, sizeof(id));

    if (strlen(id) == 0) {
        return;
    }

    char url[2048];
    Format(url, sizeof(url), "http://whitelist.tf/custom_whitelist_%s.txt", id);

    HTTPRequestHandle httpRequest = Steam_CreateHTTPRequest(HTTPMethod_GET, url);

    Steam_SendHTTPRequest(httpRequest, HTTPRequestReturned, 1);
}

public int HTTPRequestReturned(HTTPRequestHandle HTTPRequest, bool requestSuccessful, HTTPStatusCode statusCode, int contextData) {
    if (!requestSuccessful) {
        CPrintToChatAll("{orange}[whitelist.tf]{default} Encountered error while downloading whitelist.");

        ThrowError("HTTP request failed");
    }

    if (statusCode == HTTPStatusCode_OK) {
        // successfully downloaded
        char id[64];
        whitelistID.GetString(id, sizeof(id));

        char file[2048];
        Format(file, sizeof(file), "cfg/item_whitelist_%s.txt", id);

        Steam_WriteHTTPResponseBody(HTTPRequest, file);

        gameWhitelist.SetString(file);

        CPrintToChatAll("{orange}[whitelist.tf]{default} Downloaded whitelist {olive}%s{default}. You must restart tournament mode to activate the new whitelist.", id);
    }
    else if (contextData == 0) {
        // attempt to download custom whitelist
        DownloadCustomWhitelist();
    }
    else {
        // not a regular whitelist nor custom whitelist, stopping
        char id[64];
        whitelistID.GetString(id, sizeof(id));

        CPrintToChatAll("{orange}[whitelist.tf]{default} Unable to download whitelist {olive}%s{default}.", id);
    }

    Steam_ReleaseHTTPRequest(HTTPRequest);
}

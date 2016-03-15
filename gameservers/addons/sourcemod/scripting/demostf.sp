#include <sourcemod>
#include <anyhttp>
#include <compctrl_extension>
#include <morecolors>

#pragma newdecls required

ConVar apiKey;

ConVar bluTeamName;
ConVar redTeamName;

Handle uploadForward;

public Plugin myinfo = {
    name = "demos.tf",
    author = "Forward Command Post",
    description = "a plugin automatically uploading demos to demos.tf",
    version = "0.1.0",
    url = "http://demos.tf"
};

public void OnPluginStart() {
    AnyHttp.Require();

    apiKey = CreateConVar("demostf_apikey", "", "API key used for demos.tf uploads", FCVAR_PROTECTED|FCVAR_DONTRECORD|FCVAR_PLUGIN);

    bluTeamName = FindConVar("mp_tournament_blueteamname");
    redTeamName = FindConVar("mp_tournament_redteamname");

    uploadForward = CreateGlobalForward("DemoUploaded", ET_Ignore, Param_Cell, Param_String);
}

public void CompCtrl_OnStopRecording(const char[] file) {
    AnyHttpForm form = AnyHttp.CreatePost("https://demos.tf/upload");

    form.PutString("name", file);
    form.PutFile("demo", file);

    char redName[32];
    char bluName[32];
    redTeamName.GetString(redName, sizeof(redName));
    bluTeamName.GetString(bluName, sizeof(bluName));
    form.PutString("red", redName);
    form.PutString("blu", bluName);

    char key[128];
    apiKey.GetString(key, sizeof(key));
    form.PutString("key", key);

    form.Send(HttpRequestDone);
}

public void HttpRequestDone(bool success, const char[] contents, int metadata) {
    if (success) {
        CPrintToChatAll("{green}[demos.tf]{default} Failed to upload demo!");

        int result;
        Call_StartForward(uploadForward);
        Call_PushCell(false);
        Call_PushString("");
        Call_Finish(result);
    }
    else {
        int position = StrContains(contents, "STV available at: ");

        if (position != -1) {
            char url[128];
            strcopy(url, sizeof(url), contents[position + strlen("STV available at: ")]);

            CPrintToChatAll("{green}[demos.tf]{default} STV available at: {olive}%s{default}", url);

            int result;
            Call_StartForward(uploadForward);
            Call_PushCell(true);
            Call_PushString(url);
            Call_Finish(result);
        }
        else {
            PrintToServer("Error in uploading demo: %s", contents);
            CPrintToChatAll("{green}[demos.tf]{default} Failed to upload demo!");

            int result;
            Call_StartForward(uploadForward);
            Call_PushCell(false);
            Call_PushString("");
            Call_Finish(result);
        }
    }
}

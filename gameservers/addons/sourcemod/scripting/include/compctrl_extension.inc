#include <sdktools>
#include <tf2>

#pragma newdecls required

public Extension __ext_compctrl =
{
	name = "CompCtrl",
	file = "compctrl.ext",
#if defined AUTOLOAD_EXTENSIONS
	autoload = 1,
#else
	autoload = 0,
#endif
#if defined REQUIRE_EXTENSIONS
	required = 1,
#else
	required = 0,
#endif
};

enum WinReason {
	WinReason_None = 0,
	WinReason_All_Points_Captured,
	WinReason_Opponents_Dead,
	WinReason_Flag_Capture_Limit,
	WinReason_Defend_Until_Time_Limit,
	WinReason_Stalemate,
	WinReason_TimeLimit,
	WinReason_WinLimit,
	WinReason_WinDiffLimit
};

enum StalemateReason {
	StalemateReason_Join_Mid,
	StalemateReason_Timer,
	StalemateReason_Server_Timelimit
};

/**
 * @brief				Calls SetWinningTeam in CTFGameRules.
 *
 * @param team			The team that has won.
 * @param reason		The reason why the team is winning.
 * @param forceMapReset	Whether to reset the map (usually after a full round is completed).
 * @param switchTeams	Whether to switch teams.
 * @param dontAddScore	Whether to not score this round.
 * @param final			Whether this is the final round.
 * @noreturn
 */
native void CompCtrl_SetWinningTeam(TFTeam team, WinReason reason, bool forceMapReset, bool switchTeams, bool dontAddScore, bool final);

/**
 * @brief				Calls SetStalemate in CTFGameRules.
 *
 * @param reason		The reason why the team is winning.
 * @param forceMapReset	Whether to reset the map (usually after a full round is completed).
 * @param switchTeams	Whether to switch teams.
 * @noreturn
 */
native void CompCtrl_SetStalemate(StalemateReason reason, bool forceMapReset, bool switchTeams);

/**
 * @brief				Calls HandleSwitchTeams in CTFGameRules.
 *
 * @noreturn
 */
native void CompCtrl_SwitchTeams();

/*
 * @brief				Calls CleanUpMap in CTFGameRules.
 *
 * @noreturn
 */
stock void CompCtrl_CleanUpMap() {
	static Handle cleanUpMapCall = null;

	if (cleanUpMapCall == null) {
		StartPrepSDKCall(SDKCall_GameRules);

		Handle gameConf = LoadGameConfigFile("compctrl");
		PrepSDKCall_SetFromConf(gameConf, SDKConf_Virtual, "CTFGameRules::CleanUpMap");
		cleanUpMapCall = EndPrepSDKCall();
	}

	SDKCall(cleanUpMapCall);
}

/*
 * @brief				Calls State_Transition in CTFGameRules.
 *
 * @noreturn
 */
stock void CompCtrl_StateTransition(RoundState state) {
	static Handle stateTransitionCall = null;

	if (stateTransitionCall == null) {
		StartPrepSDKCall(SDKCall_GameRules);

		Handle gameConf = LoadGameConfigFile("compctrl");
		PrepSDKCall_SetFromConf(gameConf, SDKConf_Signature, "CTeamplayRoundBasedRules::State_Transition");
		PrepSDKCall_AddParameter(SDKType_PlainOldData, SDKPass_Plain);
		stateTransitionCall = EndPrepSDKCall();
	}

	SDKCall(stateTransitionCall, state);
}

/**
 * @brief				When a SourceTV demo has started to record.
 *
 * @param file			The path to the demo file.
 * @noreturn
 */
forward void CompCtrl_OnStartRecording(const char[] file);

/**
 * @brief				When a SourceTV demo has finished recording.
 *
 * @param file			The path to the demo file.
 * @noreturn
 */
forward void CompCtrl_OnStopRecording(const char[] file);

/**
 * @brief				When SetWinningTeam in CTFGameRules is called by the game.
 *
 * @param team			The team that has won.
 * @param reason		The reason why the team is winning.
 * @param forceMapReset	Whether to reset the map (usually after a full round is completed).
 * @param switchTeams	Whether to switch teams.
 * @param dontAddScore	Whether to not score this round.
 * @param final			Whether this is the final round.
 * @return				Plugin_Continue to continue with original values, Plugin_Changed to use new values, Plugin_Handled or Plugin_Stop to stop the game call.
 */
forward Action CompCtrl_OnSetWinningTeam(TFTeam &team, WinReason &reason, bool &forceMapReset, bool &switchTeams, bool &dontAddScore, bool &final);

/**
 * @brief				When SetStalemate in CTFGameRules is called by the game.
 *
 * @param reason		The reason why the team is winning.
 * @param forceMapReset	Whether to reset the map (usually after a full round is completed).
 * @param switchTeams	Whether to switch teams.
 * @return				Plugin_Continue to continue with original values, Plugin_Changed to use new values, Plugin_Handled or Plugin_Stop to stop the game call.
 */
forward Action CompCtrl_OnSetStalemate(StalemateReason &reason, bool &forceMapReset, bool &switchTeams);

/**
 * @brief				When HandleSwitchTeams in CTFGameRules is called by the game.
 *
 * @return				Plugin_Continue to allow the team switch, Plugin_Changed or above to prevent the team switch.
 */
forward Action CompCtrl_OnSwitchTeams();

/**
 * @brief				When BetweenRounds_Start in CTFGameRules is called by the game.
 *
 * @return				Plugin_Continue to allow the function to execute, Plugin_Changed or above to prevent the function from executing.
 */
forward Action CompCtrl_OnBetweenRoundsStart();

/**
 * @brief				When BetweenRounds_End in CTFGameRules is called by the game.
 *
 * @return				Plugin_Continue to allow the function to execute, Plugin_Changed or above to prevent the function from executing.
 */
forward Action CompCtrl_OnBetweenRoundsEnd();

/**
 * @brief				When BetweenRounds_Think in CTFGameRules is called by the game.
 *
 * @return				Plugin_Continue to allow the function to execute, Plugin_Changed or above to prevent the function from executing.
 */
forward Action CompCtrl_OnBetweenRoundsThink();

/**
 * @brief				When RestartTournament in CTFGameRules is called by the game.
 *
 * @return				Plugin_Continue to allow the restart, Plugin_Changed or above to prevent the restart.
 */
forward Action CompCtrl_OnRestartTournament();

/**
 * @brief				When CheckWinLimit in CTFGameRules is called by the game.
 *
 * @param allowEnd		Whether to allow the map to end upon checking this.
 * @param returnValue	The return value for the function (true for win limit reached, false for not).
 * @return				Plugin_Continue to return the original value, Plugin_Changed or above to use the new value.
 */
forward Action CompCtrl_OnCheckWinLimit(bool &allowEnd, bool &returnValue);

/**
 * @brief				When ResetScores in CTFTeam is called by the game.
 *
 * @param team			The team that is having its scores reset.
 * @return				Plugin_Continue to allow the reset, Plugin_Changed or above to prevent the reset.
 */
forward Action CompCtrl_OnResetTeamScores(TFTeam team);

#pragma newdecls optional

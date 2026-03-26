-- CreateTable
CREATE TABLE "Room" (
    "code" TEXT NOT NULL,
    "hostSeatId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "letter" TEXT,
    "roundEndsAt" BIGINT,
    "roundSeconds" INTEGER NOT NULL DEFAULT 120,
    "questionsPerRound" INTEGER NOT NULL DEFAULT 12,
    "scoringCategoryIndex" INTEGER NOT NULL DEFAULT 0,
    "correctionCategoryIndex" INTEGER NOT NULL DEFAULT 0,
    "categories" TEXT,
    "roundScores" TEXT,
    "answers" TEXT,
    "corrections" TEXT,
    "correctionTargets" TEXT,
    "correctionProgress" TEXT,
    "recentlyDisconnected" TEXT,
    "categoryPools" TEXT,
    "letterPool" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "RoomPlayer" (
    "seatId" TEXT NOT NULL,
    "roomCode" TEXT NOT NULL,
    "socketId" TEXT,
    "name" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "waitingForNextRound" BOOLEAN NOT NULL DEFAULT false,
    "disconnected" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RoomPlayer_pkey" PRIMARY KEY ("seatId")
);

-- CreateIndex
CREATE INDEX "RoomPlayer_roomCode_idx" ON "RoomPlayer"("roomCode");

-- AddForeignKey
ALTER TABLE "RoomPlayer" ADD CONSTRAINT "RoomPlayer_roomCode_fkey" FOREIGN KEY ("roomCode") REFERENCES "Room"("code") ON DELETE CASCADE ON UPDATE CASCADE;

